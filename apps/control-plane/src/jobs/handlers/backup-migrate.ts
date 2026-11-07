import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import type { ObjectStorageService } from "../../backups/object-storage.js";
import { runPgBackRest, summariseFailure, REPO_MOUNT } from "../../backups/pgbackrest.js";
import type { BackupService } from "../../backups/service.js";
import { backupConfigs, projects } from "../../db/schema.js";
import { encryptSecret } from "../../lib/crypto.js";
import { recreateProjectContainer } from "../../projects/container.js";
import type { JobDeps } from "../deps.js";
import { waitForPostgres } from "./project-create.js";
import { type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({ projectId: z.string().uuid() });
type Payload = z.infer<typeof payloadSchema>;

const STEPS = ["repoint", "restart", "stanza", "verify", "backup"] as const;

function progressFor(step: number, message: string): JobProgress {
  return {
    percent: Math.round((step / STEPS.length) * 100),
    message,
    checkpoint: { completedSteps: step },
  };
}

/**
 * Move a project's backups from local disk to object storage.
 *
 * The pointer moves; the backups do not. Everything already in the local
 * repository stays there, unreachable from the new one, which is why this
 * finishes by taking a full backup rather than declaring success and leaving
 * the project with a repository containing nothing. Until that backup lands the
 * project is `awaitingFirstBackup` and restores refuse — the same honest state
 * a freshly created project is in, and the same one a major-version upgrade
 * produces.
 *
 * The old repository volume is deliberately left alone. It is the way back if
 * the new one turns out to be wrong, and it costs disk rather than data.
 */
export function createBackupMigrateHandler(
  deps: JobDeps,
  backups: BackupService,
  storage: ObjectStorageService,
): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "backup.migrate",
    payloadSchema,

    async run({ payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled }: JobContext<Payload>) {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project || project.deletedAt) {
        return { percent: 100, message: "Project no longer exists", checkpoint: {} };
      }

      const backupConfig = backups.get(project.id);
      if (!backupConfig) throw new Error("This project has no backup configuration.");

      const spec = storage.repoSpecFor(project.ref);
      if (!spec) throw new Error("Object storage is not configured.");

      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      // ---- 1. Point the project at the new repository ---------------------
      if (step < 1) {
        throwIfCancelled();
        checkpoint(progressFor(step, "Pointing this project at object storage"));
        db.update(backupConfigs)
          .set({
            repoType: "s3",
            repoConfigEnc: encryptSecret(JSON.stringify(spec), config.masterKey),
            // Nothing is recoverable from the new repository until the backup
            // at the end of this job completes. Set now rather than later: a
            // job that dies halfway must not leave the project claiming a
            // recovery point it does not have.
            awaitingFirstBackup: true,
            lastError: null,
            updatedAt: Date.now(),
          })
          .where(eq(backupConfigs.projectId, project.id))
          .run();
        checkpoint(progressFor((step = 1), "Repository changed"));
      }

      // ---- 2. The container has to be recreated to see it ------------------
      if (step < 2) {
        throwIfCancelled();
        checkpoint(progressFor(step, "Restarting the database to pick up the new settings"));
        // pgBackRest is configured entirely through the environment, and
        // `archive_command` inherits it from the Postgres process — so a
        // running container keeps archiving to the old repository until it is
        // replaced. This is the downtime, and it is seconds.
        await recreateProjectContainer({ db, config, docker, backups }, project.id);
        checkpoint(progressFor((step = 2), "Database restarted"));
      }

      const containerId = db
        .select({ id: projects.containerId })
        .from(projects)
        .where(eq(projects.id, project.id))
        .get()?.id;
      if (!containerId) throw new Error("The project lost its container.");

      // A started container is not a running cluster. stanza-create talks to
      // Postgres, and issued the instant the container was recreated it failed
      // with "unable to find primary cluster" — every time, on a fast machine —
      // leaving the project pointed at a bucket with no stanza in it. Waited
      // for on every attempt, including a resumed one, since the container may
      // have restarted in between.
      await waitForPostgres(deps, containerId, signal, logger);

      // ---- 3. Create the stanza in the new repository ----------------------
      if (step < 3) {
        throwIfCancelled();
        checkpoint(progressFor(step, "Creating the stanza in object storage"));

        // The local repository volume is still mounted and still owned by root
        // from Docker's point of view; this is the same fix provisioning makes.
        await docker
          .exec(containerId, ["chown", "-R", "postgres:postgres", REPO_MOUNT], { user: "root" })
          .catch(() => {});

        const created = await runPgBackRest(docker, containerId, [
          "stanza-create",
          `--stanza=${backupConfig.stanza}`,
        ]);
        if (!created.ok && !/already exists/i.test(created.stderr + created.stdout)) {
          throw new Error(
            `Could not create the stanza in object storage: ${summariseFailure(
              created.stderr || created.stdout,
            )}`,
          );
        }
        checkpoint(progressFor((step = 3), "Stanza created"));
      }

      // ---- 4. Prove archiving reaches it ----------------------------------
      if (step < 4) {
        throwIfCancelled();
        checkpoint(progressFor(step, "Checking that WAL archiving reaches the bucket"));
        const check = await runPgBackRest(docker, containerId, [
          "check",
          `--stanza=${backupConfig.stanza}`,
        ]);
        if (!check.ok) {
          throw new Error(
            `WAL archiving cannot reach object storage, so this project has been left pointing at ` +
              `it but not backing up: ${summariseFailure(check.stderr || check.stdout)}`,
          );
        }
        checkpoint(progressFor((step = 4), "Archiving works"));
      }

      // ---- 5. A backup, so there is something to restore -------------------
      if (step < 5) {
        throwIfCancelled();
        checkpoint(progressFor(step, "Taking the first backup to object storage"));
        const result = await runPgBackRest(docker, containerId, [
          "backup",
          `--stanza=${backupConfig.stanza}`,
          "--type=full",
          "--start-fast",
        ]);
        if (!result.ok) {
          throw new Error(
            `The first backup to object storage failed. This is usually the credentials being ` +
              `allowed to read the bucket but not write to it: ${summariseFailure(
                result.stderr || result.stdout,
              )}`,
          );
        }
        checkpoint(progressFor((step = 5), "First backup complete"));
      }

      const now = Date.now();
      db.update(backupConfigs)
        .set({
          awaitingFirstBackup: false,
          lastRunAt: now,
          lastSuccessAt: now,
          lastError: null,
          archivingHealthy: true,
          archivingCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(backupConfigs.projectId, project.id))
        .run();

      logger.info({ ref: project.ref, bucket: spec.s3?.bucket }, "backups moved to object storage");

      return {
        percent: 100,
        message:
          `Backups now go to ${spec.s3?.bucket}. Everything taken before this is still in the ` +
          `project's local repository volume and can no longer be restored from — the volume is ` +
          `kept, so nothing has been destroyed.`,
        checkpoint: { completedSteps: 5 },
      };
    },
  };
}
