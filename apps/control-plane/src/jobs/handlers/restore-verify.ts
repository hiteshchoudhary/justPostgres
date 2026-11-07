import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import {
  backupEnv,
  needsSourceVolume,
  SOURCE_REPO_MOUNT,
  sourceRepoForRestore,
  summariseFailure,
} from "../../backups/pgbackrest.js";
import type { BackupService } from "../../backups/service.js";
import { projects } from "../../db/schema.js";
import {
  DATA_MOUNT,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  PGDATA,
  physicalNames,
} from "../../projects/naming.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({ projectId: z.string().uuid() });
type Payload = z.infer<typeof payloadSchema>;

/** How long a restored copy gets to finish recovery and answer a query. */
const STARTUP_BUDGET_MS = 10 * 60_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new JobCancelledError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new JobCancelledError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Prove that a project's backups actually restore.
 *
 * A backup nobody has ever restored is a hypothesis. This restores the latest
 * one into a throwaway volume, starts Postgres against it, waits for it to
 * finish recovery, asks it a question, and destroys the lot. It is the only
 * defensible position for a tool that promises recovery: the alternative is
 * discovering that a backup was never restorable at the exact moment somebody
 * needs it.
 *
 * It runs against the real repository but never touches the live project — a
 * separate container, a separate volume, no published port, archiving off.
 */
export function createRestoreVerifyHandler(deps: JobDeps, backups: BackupService): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "restore.verify",
    payloadSchema,

    async run({ payload, logger, signal, checkpoint, throwIfCancelled }: JobContext<Payload>): Promise<JobProgress> {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project || project.deletedAt) {
        return { percent: 100, message: "Project no longer exists", checkpoint: {} };
      }

      const backupConfig = backups.get(project.id);
      if (!backupConfig || backupConfig.awaitingFirstBackup) {
        return { percent: 100, message: "No backup to verify yet", checkpoint: {} };
      }

      const names = physicalNames(project);
      const scratchVolume = `jp-verify-${project.ref}-${Date.now().toString(36)}`;
      const containerName = `jp-verify-${project.ref}`;
      const checkId = backups.recordCheckStart(project.id);

      logger.info({ ref: project.ref }, "restore verification started");

      try {
        throwIfCancelled();
        checkpoint({ percent: 10, message: "Restoring the latest backup into a scratch volume" });

        await docker.createVolume(scratchVolume, {
          "io.justpostgres.managed": "true",
          "io.justpostgres.role": "verify",
          "io.justpostgres.project-id": project.id,
        });

        // The repository the project really archives to. This was hardcoded to
        // the local volume, so for a project on object storage verification
        // either failed against an empty volume or — for one moved there —
        // restored the pre-move backups still on it and reported the project
        // healthy. A check that can pass for the wrong reason is worse than none.
        const repo = sourceRepoForRestore(backups.repoSpec(project.id, project.ref));
        const repoMount = needsSourceVolume(repo)
          ? { readOnlyVolumes: { [names.backupVolume]: SOURCE_REPO_MOUNT } }
          : {};

        const restoreEnv = backupEnv({
          stanza: backupConfig.stanza,
          repo,
          retentionFull: backupConfig.retentionFull,
        });

        const restored = await docker.runToCompletion(
          {
            name: `${containerName}-restore`,
            image: project.image,
            entrypoint: ["/bin/bash", "-c"],
            command: [
              `chown -R postgres:postgres ${DATA_MOUNT} && ` +
                `su postgres -c 'pgbackrest restore --stanza=${backupConfig.stanza} ` +
                `--pg1-path=${PGDATA} --type=default --archive-mode=off'`,
            ],
            env: restoreEnv,
            labels: { "io.justpostgres.managed": "true", "io.justpostgres.role": "verify" },
            volumes: { [scratchVolume]: DATA_MOUNT },
            ...repoMount,
            memoryBytes: project.memoryBytes,
            nanoCpus: project.nanoCpus,
            restartPolicy: "no",
          },
          { timeoutMs: config.backups.timeoutMs },
        );

        if (restored.exitCode !== 0) {
          throw new Error(`Restore failed:\n${summariseFailure(restored.logs)}`);
        }

        throwIfCancelled();
        checkpoint({ percent: 55, message: "Starting the restored copy" });

        // No published port and archiving off: this copy must be invisible and
        // must not write anything into the real repository.
        const verifyId = await docker.createContainer({
          name: containerName,
          image: project.image,
          env: {
            POSTGRES_USER: DEFAULT_ROLE,
            POSTGRES_DB: DEFAULT_DATABASE,
            PGDATA,
            ...restoreEnv,
          },
          labels: { "io.justpostgres.managed": "true", "io.justpostgres.role": "verify" },
          volumes: { [scratchVolume]: DATA_MOUNT },
          ...repoMount,
          command: ["-c", "archive_mode=off"],
          memoryBytes: project.memoryBytes,
          nanoCpus: project.nanoCpus,
          restartPolicy: "no",
        });

        try {
          await docker.startContainer(verifyId);
          const detail = await interrogate(deps, verifyId, signal, config.backups.timeoutMs);

          backups.recordCheckEnd(checkId, { ok: true, detail });
          logger.info({ ref: project.ref, detail }, "restore verification passed");
          return { percent: 100, message: `Restore verified — ${detail}`, checkpoint: {} };
        } finally {
          await docker.removeContainer(verifyId, { force: true }).catch(() => {});
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        backups.recordCheckEnd(checkId, { ok: false, error: message });
        // Loud on purpose. A failing verification means the recovery promise is
        // not currently true, which is more urgent than most outages.
        logger.error({ ref: project.ref, err }, "RESTORE VERIFICATION FAILED");
        throw err;
      } finally {
        await docker.removeVolume(scratchVolume, { force: true }).catch(() => {});
      }
    },
  };
}

/**
 * Ask the restored copy something only a working database can answer.
 *
 * Starting is not the same as being usable, so this waits for recovery to end
 * and then reads real catalog data. Counting relations proves the catalog is
 * intact and readable, which is the cheapest question that a subtly broken
 * restore would fail.
 */
async function interrogate(
  deps: JobDeps,
  containerId: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let attempts = 0;
  let last = "waiting for the copy to start";

  while (Date.now() < deadline) {
    if (signal.aborted) throw new JobCancelledError();

    const result = await deps.docker
      .exec(
        containerId,
        [
          "psql",
          "-U",
          DEFAULT_ROLE,
          "-d",
          DEFAULT_DATABASE,
          "-tAX",
          "-c",
          // The recovery flag is spelled out explicitly rather than cast:
          // `pg_is_in_recovery()` prints `f` on its own but `false` through
          // `::text`, and a comparison against the wrong one of those silently
          // never matches — which turns this loop into a several-hour wait
          // rather than a failure anyone notices.
          "select case when pg_is_in_recovery() then 'recovering' else 'ready' end || ' ' || " +
            "(select count(*) from pg_class where relkind in ('r','p'))::text || ' ' || " +
            "coalesce(pg_last_wal_replay_lsn()::text, pg_current_wal_lsn()::text)",
        ],
        { user: "postgres" },
      )
      .catch(() => null);

    if (result?.exitCode === 0) {
      const [state, tables, lsn] = result.stdout.trim().split(" ");
      if (state === "ready") {
        return `${tables} tables, recovered to ${lsn}`;
      }
      last = "still replaying write-ahead log";
    } else if (result) {
      last = (result.stderr || result.stdout).trim().split("\n")[0] ?? last;
    }

    attempts++;
    // A copy that has not become usable within a few minutes is a failure, not
    // something to keep waiting hours for. The restore itself gets the long
    // timeout; this phase only covers "did it come up".
    if (Date.now() - startedAt > STARTUP_BUDGET_MS) {
      throw new Error(
        `The restored copy did not become usable within ${Math.round(STARTUP_BUDGET_MS / 60_000)} minutes ` +
          `after ${attempts} checks. Last state: ${last}`,
      );
    }

    await sleep(2000, signal);
  }

  throw new Error(`The restored copy never became usable. Last state: ${last}`);
}
