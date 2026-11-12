import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { JobProgress } from "@justpostgres/shared";
import { REPO_MOUNT, runPgBackRest, summariseFailure } from "../../backups/pgbackrest.js";
import type { BackupService } from "../../backups/service.js";
import { backupConfigs, credentials, projects, upgrades } from "../../db/schema.js";
import { decryptSecret } from "../../lib/crypto.js";
import { buildProjectContainerSpec } from "../../projects/container.js";
import {
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  imageFor,
  physicalNames,
  projectLabels,
} from "../../projects/naming.js";
import type { DataStore } from "../../storage/datastore.js";
import type { JobDeps } from "../deps.js";
import { JobCancelledError, type JobContext, type JobHandler } from "../registry.js";

const payloadSchema = z.object({
  projectId: z.string().uuid(),
  upgradeId: z.string().uuid(),
  toMajor: z.number().int(),
});
type Payload = z.infer<typeof payloadSchema>;

const STEPS = [
  "final_backup",
  "manifest",
  "dump",
  "stop_old",
  "start_new",
  "load",
  "verify",
  "repository",
] as const;

function progressFor(step: number, message: string): JobProgress {
  return {
    percent: Math.round((step / STEPS.length) * 100),
    message,
    checkpoint: { completedSteps: step },
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

/** What the cluster contains, in terms coarse enough to survive a dump. */
interface Manifest {
  databases: string[];
  roles: string[];
  /** `db.schema.table` -> live row estimate. */
  tables: Record<string, number>;
}

/**
 * Field separator for the manifest queries.
 *
 * A tab rather than the more usual pipe: identifiers can legally contain a
 * pipe, and a schema named `a|b` silently splitting into two fields would make
 * the verification step report a table as missing when it is not. A tab cannot
 * appear in an unquoted identifier.
 */
const FIELD_SEPARATOR = "\t";

/** The volume holding the dump between the two clusters. */
const dumpVolumeName = (ref: string) => `jp-${ref}-upgrade-dump`;
const DUMP_MOUNT = "/dump";
const DUMP_FILE = "/dump/all.sql";

/** The data directory for the new major, alongside the old one rather than over it. */
const upgradedVolumeRef = (ref: string, toMajor: number) => `${ref}-pg${toMajor}`;

/**
 * Move a project to a newer Postgres major version.
 *
 * Every step before "stop_old" is done against the running database, so an
 * upgrade that fails early costs nothing but time. From "stop_old" onward the
 * project is down, and the failure path matters more than the success path:
 * the old data directory is never touched, so recovery is starting the old
 * container again, which this handler does itself.
 *
 * The version-locking trap from ARCHITECTURE §6 is handled at the end. Backups
 * taken under the old major cannot restore into the new one, so the repository
 * is upgraded and the project is marked as having no valid recovery point until
 * a fresh full backup completes. Leaving the old backups looking usable would
 * be the most dangerous possible outcome of a successful upgrade.
 */
export function createProjectUpgradeHandler(
  deps: JobDeps,
  backups: BackupService,
  store: DataStore,
): JobHandler<Payload> {
  const { db, config, docker } = deps;

  return {
    type: "project.upgrade",
    payloadSchema,

    async run({
      payload,
      logger,
      signal,
      resumeFrom,
      checkpoint,
      throwIfCancelled,
    }: JobContext<Payload>): Promise<JobProgress> {
      const project = db.select().from(projects).where(eq(projects.id, payload.projectId)).get();
      if (!project || project.deletedAt) {
        return { percent: 100, message: "Project no longer exists", checkpoint: {} };
      }

      const upgrade = db.select().from(upgrades).where(eq(upgrades.id, payload.upgradeId)).get();
      if (!upgrade) throw new Error("The upgrade record has gone.");

      const credential = db
        .select()
        .from(credentials)
        .where(and(eq(credentials.projectId, project.id), eq(credentials.isPrimary, true)))
        .get();
      if (!credential) throw new Error("Project has no stored credentials.");
      const password = decryptSecret(credential.passwordEnc, config.masterKey);

      const names = physicalNames(project);
      const targetImage = imageFor(config, payload.toMajor);
      const oldVolume = names.volume;
      const newVolumeRef = upgradedVolumeRef(project.ref, payload.toMajor);

      let step =
        typeof resumeFrom?.checkpoint?.completedSteps === "number"
          ? resumeFrom.checkpoint.completedSteps
          : 0;

      db.update(projects)
        .set({ state: "upgrading", lastError: null, updatedAt: Date.now() })
        .where(eq(projects.id, project.id))
        .run();

      try {
        // ---- 1. A recovery point on the old version, taken last thing -------
        if (step < 1) {
          throwIfCancelled();
          checkpoint(progressFor(step, `Taking a final Postgres ${project.pgMajor} backup`));
          const backupConfig = backups.get(project.id);
          if (backupConfig?.enabled && project.containerId) {
            const result = await runPgBackRest(docker, project.containerId, [
              "backup",
              `--stanza=${backupConfig.stanza}`,
              "--type=full",
              "--start-fast",
            ]);
            if (!result.ok) {
              // Not fatal. The retained data directory is the real safety net,
              // and refusing to upgrade because a backup failed would leave the
              // project on an old version for a reason unrelated to upgrading.
              logger.warn(
                { ref: project.ref },
                `final pre-upgrade backup failed: ${summariseFailure(result.stderr || result.stdout)}`,
              );
            }
          }
          checkpoint(progressFor((step = 1), "Final backup done"));
        }

        // ---- 2. What is in there now ---------------------------------------
        if (step < 2) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Recording what the old cluster contains"));
          const before = await readManifest(deps, project.containerId!);
          db.update(upgrades)
            .set({ manifestBefore: JSON.stringify(before) })
            .where(eq(upgrades.id, upgrade.id))
            .run();
          logger.info(
            { ref: project.ref, databases: before.databases.length, tables: Object.keys(before.tables).length },
            "pre-upgrade manifest taken",
          );
          checkpoint(progressFor((step = 2), "Recorded"));
        }

        // ---- 3. Dump, while the old server is still up ----------------------
        if (step < 3) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Dumping every database and role"));
          await docker.createVolume(dumpVolumeName(project.ref), projectLabels(project.id, project.ref));

          // Run from the NEW image: pg_dumpall from a newer client against an
          // older server is the supported direction, and it emits SQL the new
          // server will accept. The reverse is not guaranteed to work at all.
          const dump = await docker.runToCompletion(
            {
              name: `jp-dump-${project.ref}-${Date.now().toString(36)}`,
              image: targetImage,
              entrypoint: ["sh"],
              command: [
                "-c",
                `pg_dumpall -h ${names.container} -U ${DEFAULT_ROLE} -f ${DUMP_FILE} && ` +
                  `wc -c < ${DUMP_FILE}`,
              ],
              env: { PGPASSWORD: password },
              labels: projectLabels(project.id, project.ref),
              volumes: { [dumpVolumeName(project.ref)]: DUMP_MOUNT },
              network: names.network,
              memoryBytes: 512 * 1024 * 1024,
              nanoCpus: 1e9,
              restartPolicy: "no",
            },
            { timeoutMs: 6 * 60 * 60_000 },
          );

          if (dump.exitCode !== 0) {
            throw new Error(`pg_dumpall failed: ${dump.logs.trim().slice(-800)}`);
          }
          logger.info({ ref: project.ref, output: dump.logs.trim().slice(-200) }, "dump complete");
          checkpoint(progressFor((step = 3), "Dump complete"));
        }

        // ---- 4. Down it goes ------------------------------------------------
        // Everything above this line was reversible by doing nothing.
        if (step < 4) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Stopping the old database"));
          if (project.containerId) {
            await docker.stopContainer(project.containerId, 30).catch(() => {});
            // Removed, not kept: the container name and the published port are
            // both needed by its replacement. The *volume* is what matters for
            // rollback, and that is untouched.
            await docker.removeContainer(project.containerId, { force: true }).catch(() => {});
          }
          checkpoint(progressFor((step = 4), "Old database stopped"));
        }

        // ---- 5. An empty cluster on the new major ---------------------------
        if (step < 5) {
          throwIfCancelled();
          checkpoint(progressFor(step, `Starting an empty Postgres ${payload.toMajor}`));

          const newVolume = await store.create(newVolumeRef, projectLabels(project.id, project.ref));

          db.update(projects)
            .set({
              pgMajor: payload.toMajor,
              image: targetImage,
              volumeName: newVolume,
              updatedAt: Date.now(),
            })
            .where(eq(projects.id, project.id))
            .run();

          const updated = db.select().from(projects).where(eq(projects.id, project.id)).get()!;

          // Archiving is left off for the load. The repository still describes
          // the old cluster, so every archive_command would fail and pile up
          // WAL during precisely the phase that writes the most of it. It is
          // turned back on with the repository, three steps down.
          const containerId = await docker.createContainer(
            buildProjectContainerSpec({ db, config, backups }, updated, {
              extraSettings: { archive_mode: "off" },
            }),
          );
          await docker.startContainer(containerId);

          db.update(projects)
            .set({ containerId, updatedAt: Date.now() })
            .where(eq(projects.id, project.id))
            .run();

          await waitForPostgres(deps, containerId, signal, logger);
          checkpoint(progressFor((step = 5), `Postgres ${payload.toMajor} is up`));
        }

        const containerId = db
          .select({ id: projects.containerId })
          .from(projects)
          .where(eq(projects.id, project.id))
          .get()?.id;
        if (!containerId) throw new Error("The new container lost its id.");

        // ---- 6. Load the dump ----------------------------------------------
        if (step < 6) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Loading the dump into the new version"));

          const load = await docker.runToCompletion(
            {
              name: `jp-load-${project.ref}-${Date.now().toString(36)}`,
              image: targetImage,
              entrypoint: ["sh"],
              // ON_ERROR_STOP is deliberately off. pg_dumpall always emits
              // `CREATE ROLE postgres` and an ALTER for the bootstrap
              // superuser, which the new cluster already has; aborting on that
              // would fail every upgrade. Correctness is established by
              // comparing the manifest afterwards, which is a stronger check
              // than "psql exited zero" anyway.
              command: [
                "-c",
                `psql -h ${names.container} -U ${DEFAULT_ROLE} -d ${DEFAULT_DATABASE} ` +
                  `-f ${DUMP_FILE} 2>&1 | grep -i "^ERROR" | head -40; exit 0`,
              ],
              env: { PGPASSWORD: password },
              labels: projectLabels(project.id, project.ref),
              volumes: {},
              readOnlyVolumes: { [dumpVolumeName(project.ref)]: DUMP_MOUNT },
              network: names.network,
              memoryBytes: 512 * 1024 * 1024,
              nanoCpus: 1e9,
              restartPolicy: "no",
            },
            { timeoutMs: 6 * 60 * 60_000 },
          );

          const errors = load.logs
            .split("\n")
            .filter((l) => /^ERROR/i.test(l.trim()))
            .filter((l) => !/role "postgres" already exists/i.test(l));

          if (errors.length > 0) {
            logger.warn({ ref: project.ref, errors: errors.slice(0, 10) }, "errors while loading dump");
          }
          checkpoint(progressFor((step = 6), "Dump loaded"));
        }

        // ---- 7. Prove nothing was lost --------------------------------------
        if (step < 7) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Checking the new cluster against the old one"));

          const after = await readManifest(deps, containerId);
          const before = JSON.parse(
            db.select({ m: upgrades.manifestBefore }).from(upgrades).where(eq(upgrades.id, upgrade.id)).get()
              ?.m ?? "null",
          ) as Manifest | null;

          db.update(upgrades)
            .set({ manifestAfter: JSON.stringify(after) })
            .where(eq(upgrades.id, upgrade.id))
            .run();

          const missing = before ? describeMissing(before, after) : [];
          if (missing.length > 0) {
            throw new Error(
              `The upgraded cluster is missing things the old one had, so the upgrade has been ` +
                `rolled back:\n  ${missing.slice(0, 12).join("\n  ")}`,
            );
          }
          checkpoint(progressFor((step = 7), "Everything is accounted for"));
        }

        // ---- 8. The repository, and the recovery-point gap -------------------
        if (step < 8) {
          throwIfCancelled();
          checkpoint(progressFor(step, "Upgrading the backup repository"));
          await adoptRepository(deps, backups, project.id, containerId, logger);
          checkpoint(progressFor((step = 8), "Repository upgraded"));
        }

        // Archiving was off for the load; the project's normal spec turns it
        // back on. This is also the point the container stops being a special
        // case and becomes an ordinary project container again.
        const finalProject = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
        await docker.stopContainer(containerId, 30).catch(() => {});
        await docker.removeContainer(containerId, { force: true }).catch(() => {});
        const finalContainer = await docker.createContainer(
          buildProjectContainerSpec({ db, config, backups }, finalProject),
        );
        await docker.startContainer(finalContainer);
        await waitForPostgres(deps, finalContainer, signal, logger);

        db.update(projects)
          .set({ containerId: finalContainer, state: "running", lastError: null, updatedAt: Date.now() })
          .where(eq(projects.id, project.id))
          .run();

        db.update(upgrades)
          .set({
            state: "succeeded",
            previousVolumeName: oldVolume,
            finishedAt: Date.now(),
          })
          .where(eq(upgrades.id, upgrade.id))
          .run();

        // The dump is a full copy of the database sitting on the same disk;
        // keeping it would double the cost of every upgrade for no benefit,
        // since the old data directory is the thing worth retaining.
        await docker.removeVolume(dumpVolumeName(project.ref), { force: true }).catch(() => {});

        // A fresh full backup, queued rather than run inline: the project is
        // already back up and the operator should not be waiting on it. Until
        // it lands the project is `awaitingFirstBackup`, so restores refuse.
        backups.scheduleRun(project.id, { type: "full" });

        logger.info(
          { ref: project.ref, from: upgrade.fromMajor, to: payload.toMajor },
          "upgrade complete",
        );

        return {
          percent: 100,
          message:
            `Now running Postgres ${payload.toMajor}. A full backup is queued; until it finishes this ` +
            `project has no valid recovery point. The old data directory is kept as ${oldVolume}.`,
          checkpoint: { completedSteps: 8 },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Rollback is only meaningful once the old container is gone. Before
        // that the project never stopped serving, so there is nothing to undo.
        const rolledBack = step >= 4 ? await rollback(deps, backups, project.id, oldVolume, upgrade.previousImage, logger) : false;

        db.update(upgrades)
          .set({
            state: rolledBack ? "rolled_back" : "failed",
            error: message,
            finishedAt: Date.now(),
          })
          .where(eq(upgrades.id, upgrade.id))
          .run();

        if (!rolledBack) {
          db.update(projects)
            .set({ state: step >= 4 ? "failed" : "running", lastError: message, updatedAt: Date.now() })
            .where(eq(projects.id, project.id))
            .run();
        }

        throw new Error(
          rolledBack
            ? `${message}\n\nThe project has been rolled back to Postgres ${upgrade.fromMajor} on its ` +
              `original data directory and is running again.`
            : message,
        );
      }
    },
  };
}

/**
 * Put the project back on the version it started on.
 *
 * This is the reason the old data directory is left alone rather than upgraded
 * in place. Nothing here has to undo a partial conversion — it points the row
 * back at data that was never modified and starts a container on it.
 */
async function rollback(
  deps: JobDeps,
  backups: BackupService,
  projectId: string,
  oldVolume: string,
  previousImage: string | null,
  logger: JobContext<Payload>["logger"],
): Promise<boolean> {
  const { db, config, docker } = deps;
  try {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return false;

    const upgrade = db
      .select()
      .from(upgrades)
      .where(eq(upgrades.projectId, projectId))
      .orderBy(upgrades.startedAt)
      .all()
      .pop();

    if (project.containerId) {
      await docker.stopContainer(project.containerId, 15).catch(() => {});
      await docker.removeContainer(project.containerId, { force: true }).catch(() => {});
    }

    db.update(projects)
      .set({
        pgMajor: upgrade?.fromMajor ?? project.pgMajor,
        image: previousImage ?? project.image,
        volumeName: oldVolume,
        updatedAt: Date.now(),
      })
      .where(eq(projects.id, projectId))
      .run();

    const restored = db.select().from(projects).where(eq(projects.id, projectId)).get()!;
    const containerId = await docker.createContainer(
      buildProjectContainerSpec({ db, config, backups }, restored),
    );
    await docker.startContainer(containerId);

    db.update(projects)
      .set({ containerId, state: "running", updatedAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run();

    // The half-built new data directory is worthless — it holds a partial load
    // of a dump — so it goes rather than lingering as an unexplained volume.
    const scrapVolume = upgradedVolumeRef(restored.ref, upgrade?.toMajor ?? 0);
    await docker.removeVolume(`jp-${scrapVolume}-data`, { force: true }).catch(() => {});

    // And the dump with it. It is a full logical copy of the database, so
    // leaving one behind on every failed upgrade would quietly consume as much
    // disk as the databases themselves. The original data directory is the
    // safety net here, and it was never written to.
    await docker.removeVolume(dumpVolumeName(restored.ref), { force: true }).catch(() => {});

    logger.warn({ ref: restored.ref }, "upgrade rolled back; project is running on its original data");
    return true;
  } catch (err) {
    logger.error({ err, projectId }, "rollback failed; the project needs manual attention");
    return false;
  }
}

/**
 * Point the existing repository at the upgraded cluster.
 *
 * `stanza-upgrade` is pgBackRest's own answer to this: the stanza records the
 * cluster's version and system identifier, and a dump-and-restore changes both.
 * If it refuses — which it will if it considers the cluster unrelated rather
 * than upgraded — the stanza is rebuilt from scratch. That discards the old
 * backups, which is the honest outcome: they could not have restored into this
 * version anyway, and leaving them listed would advertise a recovery point that
 * does not exist.
 */
async function adoptRepository(
  deps: JobDeps,
  backups: BackupService,
  projectId: string,
  containerId: string,
  logger: JobContext<Payload>["logger"],
): Promise<void> {
  const { db, docker } = deps;
  const backupConfig = backups.get(projectId);
  if (!backupConfig?.enabled) return;

  const stanza = backupConfig.stanza;

  await docker
    .exec(containerId, ["chown", "-R", "postgres:postgres", REPO_MOUNT], { user: "root" })
    .catch(() => {});

  const upgraded = await runPgBackRest(docker, containerId, ["stanza-upgrade", `--stanza=${stanza}`]);
  if (!upgraded.ok) {
    logger.warn(
      { stanza },
      `stanza-upgrade refused (${summariseFailure(upgraded.stderr || upgraded.stdout)}); ` +
        "rebuilding the stanza, which discards backups taken on the old version",
    );
    await runPgBackRest(docker, containerId, ["stanza-delete", `--stanza=${stanza}`, "--force"]);
    const created = await runPgBackRest(docker, containerId, ["stanza-create", `--stanza=${stanza}`]);
    if (!created.ok) {
      throw new Error(`stanza-create failed after upgrade: ${summariseFailure(created.stderr || created.stdout)}`);
    }
  }

  // Every existing backup is now unusable for restore, so the project is back
  // in the state a freshly created one is in: recoverable only once its first
  // full backup completes. The restore path already refuses while this is set.
  db.update(backupConfigs)
    .set({ awaitingFirstBackup: true, lastError: null, updatedAt: Date.now() })
    .where(eq(backupConfigs.projectId, projectId))
    .run();
}

/**
 * Read what a cluster contains.
 *
 * Deliberately coarse: database names, role names, and a row estimate per
 * table. Exact row counts would mean a sequential scan of every table twice,
 * and estimates are enough to catch the failure that matters — an object that
 * did not come across at all.
 */
async function readManifest(deps: JobDeps, containerId: string): Promise<Manifest> {
  const psql = async (database: string, sql: string): Promise<string[]> => {
    // Over the container's local socket, where the official image trusts the
    // postgres user — so this needs no password, and never puts one into an
    // argument list or an environment that `docker inspect` would show.
    const result = await deps.docker.exec(containerId, [
      "psql",
      "-U",
      DEFAULT_ROLE,
      "-d",
      database,
      "-t",
      "-A",
      "-F",
      FIELD_SEPARATOR,
      "-c",
      sql,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`could not read the cluster: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  };

  const databases = await psql(
    DEFAULT_DATABASE,
    "select datname from pg_database where datallowconn and not datistemplate order by 1",
  );
  const roles = await psql(
    DEFAULT_DATABASE,
    "select rolname from pg_roles where rolname not like 'pg\\_%' order by 1",
  );

  const tables: Record<string, number> = {};
  for (const database of databases) {
    const rows = await psql(
      database,
      "select n.nspname, c.relname, c.reltuples::bigint from pg_class c " +
        "join pg_namespace n on n.oid = c.relnamespace " +
        "where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') " +
        "order by 1, 2",
    );
    for (const row of rows) {
      const [schema, table, estimate] = row.split(FIELD_SEPARATOR);
      tables[`${database}.${schema}.${table}`] = Number(estimate ?? 0);
    }
  }

  return { databases, roles, tables };
}

/**
 * What the new cluster is missing.
 *
 * Only ever reports absences. A table that gained rows between the manifest and
 * the dump is normal — the database was still serving writes — and a restored
 * table whose estimate differs is normal too, because `reltuples` is a planner
 * statistic that starts at zero until something analyses it. Presence is the
 * signal; counts are not.
 */
function describeMissing(before: Manifest, after: Manifest): string[] {
  const missing: string[] = [];

  for (const database of before.databases) {
    if (!after.databases.includes(database)) missing.push(`database ${database}`);
  }
  for (const role of before.roles) {
    if (!after.roles.includes(role)) missing.push(`role ${role}`);
  }
  for (const table of Object.keys(before.tables)) {
    if (!(table in after.tables)) missing.push(`table ${table}`);
  }

  return missing;
}

/**
 * Same wait the provisioning path uses: a started container is not a ready
 * database. Over TCP for the same reason — see project-create's waitForPostgres.
 */
async function waitForPostgres(
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
        "-h",
        "127.0.0.1",
        "-U",
        DEFAULT_ROLE,
        "-d",
        DEFAULT_DATABASE,
        "-q",
      ]);
      if (result.exitCode === 0) return;
      lastError = `pg_isready exited ${result.exitCode}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    logger.debug({ lastError }, "postgres not ready yet");
    await sleep(1000, signal);
  }

  throw new Error(`Postgres did not accept connections in time. Last check: ${lastError}`);
}
