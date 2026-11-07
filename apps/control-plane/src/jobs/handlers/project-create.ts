import { eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import {
  projects,
} from "../../db/schema.js";
import {
  REPO_MOUNT,
  runPgBackRest,
} from "../../backups/pgbackrest.js";
import { backupConfigs, projects as projectsTable } from "../../db/schema.js";
import {
  backupVolumeName,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  networkName,
  projectLabels,
  stanzaName,
} from "../../projects/naming.js";
import type { BackupService } from "../../backups/service.js";
import { buildProjectContainerSpec } from "../../projects/container.js";
import type { DataStore } from "../../storage/datastore.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({ projectId: z.string().uuid() });
type Payload = z.infer<typeof payloadSchema>;

/**
 * Ordered, idempotent steps. The checkpoint records how many have completed, so
 * a job resumed after a crash skips straight to the first unfinished one.
 */
const STEPS = [
  "pull_image",
  "create_volume",
  "create_network",
  "create_container",
  "start_container",
  "wait_ready",
  "init_backups",
] as const;

function progressFor(stepIndex: number, message: string): JobProgress {
  return {
    percent: Math.round((stepIndex / STEPS.length) * 100),
    message,
    checkpoint: { completedSteps: stepIndex },
  };
}

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

export function createProjectCreateHandler(
  deps: JobDeps,
  store: DataStore,
  backups: BackupService,
): JobHandler<Payload> {
  const { db, docker } = deps;

  return {
    type: "project.create",
    payloadSchema,

    async run(ctx: JobContext<Payload>): Promise<JobProgress> {
      const { payload, logger, signal, resumeFrom, checkpoint, throwIfCancelled } = ctx;

      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project) throw new Error(`Project ${payload.projectId} no longer exists`);
      if (project.deletedAt) throw new Error("Project was deleted before provisioning finished");

      const ref = project.ref;
      const labels = projectLabels(project.id, ref);
      const done =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      if (done > 0) logger.info({ resumedAfterStep: STEPS[done - 1], ref }, "resuming provisioning");

      // A retry after a failure should show the project as being worked on
      // again rather than leaving it stuck in `failed`.
      db.update(projects)
        .set({ state: "creating", lastError: null, updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
        .run();

      try {
        let step = done;

        if (step < 1) {
          throwIfCancelled();
          await ensureImage(deps, project.image, logger, (message) =>
            checkpoint(progressFor(step, message)),
          );
          checkpoint(progressFor((step = 1), "Image ready"));
        }

        if (step < 2) {
          throwIfCancelled();
          // Through the data store: on a copy-on-write host this is a subvolume
          // presented as a volume, which is what makes branching a snapshot.
          await store.create(ref, labels);
          // The repository volume is created alongside the data volume, always.
          // Backups are not opt-in: a database tool whose backups are off by
          // default is a database tool that does not back up.
          await docker.createVolume(backupVolumeName(ref), labels);
          checkpoint(progressFor((step = 2), "Volumes created"));
        }

        if (step < 3) {
          throwIfCancelled();
          await docker.createNetwork(networkName(ref), labels);
          checkpoint(progressFor((step = 3), "Network created"));
        }

        if (step < 4) {
          throwIfCancelled();
          const containerId = await ensureContainer(deps, backups, project.id);
          db.update(projects)
            .set({ containerId, updatedAt: Date.now() })
            .where(eq(projects.id, project.id))
            .run();
          checkpoint(progressFor((step = 4), "Container created"));
        }

        const containerId =
          db.select({ id: projects.containerId }).from(projects).where(eq(projects.id, project.id)).get()
            ?.id ?? null;
        if (!containerId) throw new Error("Container id missing after creation step");

        if (step < 5) {
          throwIfCancelled();
          await docker.startContainer(containerId);
          checkpoint(progressFor((step = 5), "Container started"));
        }

        if (step < 6) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Waiting for Postgres to accept connections"));
          await waitForPostgres(deps, containerId, signal, logger);
          checkpoint(progressFor((step = 6), "Postgres is accepting connections"));
        }

        if (step < 7) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Setting up continuous archiving"));
          await initialiseBackups(deps, backups, project.id, ref, containerId, logger);
          checkpoint(progressFor((step = 7), "Archiving is on"));
        }

        db.update(projects)
          .set({ state: "running", lastError: null, updatedAt: Date.now() })
          .where(eq(projects.id, project.id))
          .run();

        // The first full backup, now. Archived WAL is useless without a base
        // backup to replay it onto, so until this lands the project has no
        // recovery point at all — and nothing else queued one: it waited for
        // the periodic scheduler sweep, leaving every new project unprotected
        // for up to fifteen minutes while the UI showed archiving as healthy.
        if (backups.get(project.id)?.awaitingFirstBackup) {
          backups.scheduleRun(project.id, { type: "full" });
        }

        logger.info({ ref, port: project.hostPort }, "project provisioned");
        return { percent: 100, message: "Project is running", checkpoint: { completedSteps: 7 } };
      } catch (err) {
        if (err instanceof JobCancelledError) throw err;

        const message = err instanceof Error ? err.message : String(err);
        // Only give up visibly once the queue has no retries left; a project
        // shown as `failed` between automatic attempts is just noise.
        const isFinalAttempt = ctx.job.attempts >= ctx.job.maxAttempts;
        db.update(projects)
          .set({
            state: isFinalAttempt ? "failed" : "creating",
            lastError: message,
            updatedAt: Date.now(),
          })
          .where(eq(projects.id, project.id))
          .run();
        throw err;
      }
    },
  };
}

/**
 * Make the image available, preferring one already on the host.
 *
 * The project images are built locally (`images/postgres/build.sh`) and are not
 * published to a registry, so an unconditional pull fails with "pull access
 * denied" on an image that is sitting right there. Local-first is also the
 * correct behaviour for a pinned tag generally: it avoids a network round trip
 * per project and works on an air-gapped host.
 */
async function ensureImage(
  deps: JobDeps,
  image: string,
  logger: JobContext<Payload>["logger"],
  report: (message: string) => void,
): Promise<void> {
  if (await deps.docker.imageExists(image)) {
    logger.debug({ image }, "image already present");
    report(`Using local image ${image}`);
    return;
  }

  logger.info({ image }, "pulling image");
  report(`Pulling ${image}`);
  try {
    await deps.docker.pullImage(image);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Image ${image} is not on this host and could not be pulled (${message}). ` +
        "Build it first with images/postgres/build.sh, or point " +
        "JP_POSTGRES_IMAGE_TEMPLATE at an image that exists.",
    );
  }
}

/**
 * Create the container, or adopt one that already exists.
 *
 * The adoption path matters: if a previous attempt created the container and
 * died before recording its id, creating again fails on the duplicate name and
 * the project can never finish. Labels are what make the orphan findable.
 */
async function ensureContainer(
  deps: JobDeps,
  backups: BackupService,
  projectId: string,
): Promise<string> {
  const { db, config, docker } = deps;

  // Adoption path: if a previous attempt created the container but died before
  // recording its id, creating again fails on the duplicate name and the
  // project can never finish. Labels are what make the orphan findable.
  const existing = await docker.listContainers({ "io.justpostgres.project-id": projectId });
  if (existing.length > 0) return existing[0]!.id;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error("Project disappeared during provisioning");

  return docker.createContainer(buildProjectContainerSpec({ db, config, backups }, project));
}

/**
 * Poll until Postgres accepts connections.
 *
 * A started container is not a ready database: initdb runs on first boot, and
 * on a slow disk that is tens of seconds. Reporting the project as running
 * before `pg_isready` succeeds would hand the user a connection string that
 * refuses connections.
 */
export async function waitForPostgres(
  deps: JobDeps,
  containerId: string,
  signal: AbortSignal,
  logger: JobContext<Payload>["logger"],
): Promise<void> {
  const deadline = Date.now() + deps.config.projects.readyTimeoutMs;
  let lastError = "no attempt completed";

  while (Date.now() < deadline) {
    if (signal.aborted) throw new JobCancelledError();

    try {
      const result = await deps.docker.exec(containerId, [
        "pg_isready",
        "-U",
        DEFAULT_ROLE,
        "-d",
        DEFAULT_DATABASE,
        "-q",
      ]);
      if (result.exitCode === 0) return;
      lastError = `pg_isready exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    logger.debug({ lastError }, "postgres not ready yet");
    await sleep(1000, signal);
  }

  throw new Error(
    `Postgres did not accept connections within ${Math.round(
      deps.config.projects.readyTimeoutMs / 1000,
    )}s. Last check: ${lastError}`,
  );
}


/**
 * Bring continuous archiving online for a freshly created project.
 *
 * The container already starts with `archive_mode=on`, so Postgres is trying to
 * archive from its first WAL segment and failing until the stanza exists. That
 * is fine and intended: Postgres retries archiving indefinitely, so the only
 * cost of the gap is a few seconds of WAL sitting in pg_wal. The alternative —
 * turning archiving on later — needs a restart, and a project that has already
 * accepted writes should not need one to become recoverable.
 */
async function initialiseBackups(
  deps: JobDeps,
  backups: BackupService,
  projectId: string,
  ref: string,
  containerId: string,
  logger: JobContext<Payload>["logger"],
): Promise<void> {
  const { db, docker } = deps;
  const stanza = stanzaName(ref);

  // The repository volume is created root-owned by Docker; pgBackRest runs as
  // postgres and cannot write into it until this is fixed.
  const chown = await docker.exec(containerId, ["chown", "-R", "postgres:postgres", REPO_MOUNT], {
    user: "root",
  });
  if (chown.exitCode !== 0) {
    throw new Error(`Could not prepare the backup repository: ${chown.stderr.trim()}`);
  }

  const created = await runPgBackRest(docker, containerId, ["stanza-create", `--stanza=${stanza}`]);
  // Re-running provisioning must not fail on a stanza that already exists.
  if (!created.ok && !/already exists/i.test(created.stderr + created.stdout)) {
    throw new Error(`pgbackrest stanza-create failed: ${(created.stderr || created.stdout).trim()}`);
  }

  const check = await runPgBackRest(docker, containerId, ["check", `--stanza=${stanza}`]);
  if (!check.ok) {
    throw new Error(
      `pgbackrest check failed, so WAL archiving is not working: ${(check.stderr || check.stdout).trim()}`,
    );
  }

  // Through the service, not inserted here. This used to be a second copy of
  // the same INSERT, and it silently ignored object storage configured from the
  // UI — new projects kept backing up to local disk while the settings page
  // said otherwise. One place decides where a project's backups go.
  if (!backups.get(projectId)) backups.initialise(projectId, ref);

  db.update(projectsTable)
    .set({ backupVolumeName: backupVolumeName(ref), updatedAt: Date.now() })
    .where(eq(projectsTable.id, projectId))
    .run();

  logger.info({ ref, stanza }, "archiving initialised");
}
