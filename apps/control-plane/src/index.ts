import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { createApp } from "./api/app.js";
import type { AppContext } from "./api/context.js";
import { loadConfig } from "./config.js";
import { DataPoolManager } from "./data/pool.js";
import { ExtensionService } from "./extensions/service.js";
import { RestService } from "./rest/service.js";
import { RlsService } from "./rest/rls.js";
import { openDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { AuthService } from "./auth/service.js";
import { RestoreService } from "./backups/restore.js";
import { BranchService } from "./branches/service.js";
import { BackupService } from "./backups/service.js";
import { DockerodeDriver } from "./docker/dockerode-driver.js";
import { createRegistry, JobQueue, JobWorker } from "./jobs/index.js";
import { createLogger } from "./logger.js";
import { Reconciler } from "./projects/reconciler.js";
import { ProjectService } from "./projects/service.js";
import { createDataStore } from "./storage/datastore.js";
import { DiskMonitor } from "./storage/disk.js";
import { UpgradeService } from "./upgrades/service.js";
import { ControlPlaneBackupService } from "./admin/cp-backup.js";
import { resetAdmin } from "./admin/reset-admin.js";
import { MetricsService } from "./metrics/service.js";
import { ObjectStorageService } from "./backups/object-storage.js";

const VERSION = process.env.JP_VERSION || "0.0.0-dev";

/** Migrations sit next to the build output in both dev (src/..) and the image (dist/..). */
function resolveMigrationsDir(): string {
  if (process.env.JP_MIGRATIONS_DIR) return process.env.JP_MIGRATIONS_DIR;
  const candidate = fileURLToPath(new URL("../drizzle", import.meta.url));
  if (existsSync(candidate)) return candidate;
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

/**
 * Commands that operate on the data directory and exit, rather than serving.
 *
 * Run against a live deployment with `docker compose exec`, so they see the
 * same volume and the same environment the server does — which matters,
 * because everything here depends on `JP_MASTER_KEY` being the right one.
 */
async function runCommand(command: string): Promise<boolean> {
  if (command !== "reset-admin") return false;

  const config = loadConfig();
  const logger = createLogger(config);
  await resetAdmin(config, logger, resolveMigrationsDir());
  return true;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command && (await runCommand(command))) return;
  if (command && command !== "serve") {
    throw new Error(
      `Unknown command "${command}". Available: serve (default), reset-admin.`,
    );
  }

  const config = loadConfig();
  const logger = createLogger(config);

  logger.info(
    { version: VERSION, nodeEnv: config.nodeEnv, dataDir: config.dataDir },
    "justpostgres control plane starting",
  );

  if (config.masterKeyIsEphemeral) {
    logger.warn(
      "JP_MASTER_KEY is not set; using an ephemeral development key. " +
        "Anything encrypted with it becomes unreadable on restart. Never do this in production.",
    );
  }

  const db = openDatabase(config, logger);
  runMigrations(db, resolveMigrationsDir(), logger);

  const docker = new DockerodeDriver(config, logger.child({ component: "docker" }));
  const queue = new JobQueue(db.db, config.jobs.leaseTtlMs);
  // Free space is measured, not assumed, and the measurement is shared: the
  // provisioning path, the backup runner and the health endpoint all decide
  // from the same sample rather than each running their own `df`.
  const disk = new DiskMonitor(
    config,
    docker,
    logger.child({ component: "disk" }),
    config.projects.imageTemplate.replace("{major}", String(config.projects.defaultPgMajor)),
  );
  const jobDeps = { db: db.db, config, docker, disk };
  const dataPools = new DataPoolManager(db.db, config, logger.child({ component: "data" }));
  const backups = new BackupService(
    db.db,
    config,
    docker,
    queue,
    logger.child({ component: "backups" }),
  );
  const restores = new RestoreService(
    db.db,
    config,
    docker,
    queue,
    backups,
    logger.child({ component: "restore" }),
    disk,
  );
  // Object storage for backups, configured from the UI. Handed to the backup
  // service rather than constructed inside it: it needs the Docker driver, and
  // the backup service is built before the driver has anywhere to run probes.
  const objectStorage = new ObjectStorageService(
    db.db,
    config,
    docker,
    logger.child({ component: "object-storage" }),
    config.projects.imageTemplate.replace("{major}", String(config.projects.defaultPgMajor)),
  );
  backups.useObjectStorage(objectStorage);

  // The data store decides whether branching can be a filesystem clone. It is
  // built before the registry because the provisioning handlers need it.
  const dataStore = createDataStore(
    config,
    docker,
    logger.child({ component: "storage" }),
    config.projects.imageTemplate.replace("{major}", String(config.projects.defaultPgMajor)),
  );
  // Proven, not assumed. A copy-on-write root that is not mounted looks
  // identical to one that is until project data is written to the wrong disk,
  // so this runs before anything can provision. It is reported rather than
  // fatal: the control plane's job includes being available to explain the
  // problem, and `create` refuses on its own until the store checks out.
  const storeStatus = await dataStore.verify();
  if (storeStatus.ok) {
    logger.info(
      {
        driver: dataStore.kind,
        snapshots: dataStore.supportsSnapshot,
        root: storeStatus.root,
      },
      `data store ready — ${storeStatus.detail}`,
    );
  } else {
    logger.error(
      { driver: dataStore.kind, root: storeStatus.root },
      "STORAGE IS NOT USABLE. No project will be created until this is fixed.\n" +
        `\n  ${storeStatus.detail}\n`,
    );
  }

  const registry = createRegistry(jobDeps, backups, dataStore, dataPools, objectStorage);
  const worker = new JobWorker(queue, registry, config, logger.child({ component: "worker" }));

  const auth = new AuthService(db.db, config);
  const projects = new ProjectService(
    db.db,
    config,
    docker,
    queue,
    logger.child({ component: "projects" }),
    disk,
  );
  const reconciler = new Reconciler(
    db.db,
    config,
    docker,
    logger.child({ component: "reconciler" }),
  );

  const branches = new BranchService(
    db.db,
    config,
    queue,
    restores,
    dataStore,
    logger.child({ component: "branches" }),
    disk,
  );

  const extensions = new ExtensionService(
    db.db,
    dataPools,
    queue,
    logger.child({ component: "extensions" }),
  );

  const rest = new RestService(
    db.db,
    config,
    docker,
    dataPools,
    queue,
    logger.child({ component: "rest" }),
  );
  const rls = new RlsService(dataPools);

  // The metadata store is the one piece of state the host cannot rebuild by
  // itself, so it backs itself up.
  const controlPlaneBackups = new ControlPlaneBackupService(
    config,
    db,
    logger.child({ component: "cp-backup" }),
  );

  const metrics = new MetricsService(db.db, dataPools, logger.child({ component: "metrics" }));

  const upgradeService = new UpgradeService(
    db.db,
    config,
    docker,
    queue,
    backups,
    disk,
    logger.child({ component: "upgrades" }),
  );

  const ctx: AppContext = {
    config,
    logger,
    db,
    queue,
    worker,
    docker,
    auth,
    projects,
    reconciler,
    dataPools,
    extensions,
    rest,
    rls,
    backups,
    restores,
    branches,
    dataStore,
    disk,
    upgrades: upgradeService,
    controlPlaneBackups,
    metrics,
    objectStorage,
    startedAt: Date.now(),
    version: VERSION,
  };

  if (auth.setupRequired()) {
    const token = auth.setupToken();
    // Deliberately printed on every boot while unclaimed, not only the first.
    // An operator who missed it, or inherited the box from someone who did,
    // should be able to find it by restarting rather than by editing the
    // database.
    logger.warn(
      { setupToken: token },
      "This instance has no administrator yet and is UNCLAIMED.\n" +
        "\n" +
        "  Open the control plane and complete setup with this token:\n" +
        `\n      ${token}\n` +
        "\n" +
        "  Until someone does, anyone who can reach this port could claim it —\n" +
        "  which is why the token is required. Keep the port on loopback (the\n" +
        "  compose file does by default) and reach it over an SSH tunnel.\n",
    );
  }

  // Said out loud at boot, because the default is permissive and the
  // consequence is not obvious from the config file. A project's Postgres is
  // published on a host port; on every interface, that port is reachable from
  // wherever the host is reachable — the internet, on a VPS with no firewall.
  // Credentials still stand in the way, but a database that answers the
  // internet is a database being brute-forced.
  if (!["127.0.0.1", "localhost", "::1"].includes(config.projectBindAddr)) {
    logger.warn(
      { bindAddr: config.projectBindAddr, portRange: `${config.portRange.start}-${config.portRange.end}` },
      "Project database ports are published on all interfaces.\n" +
        `\n  Firewall ${config.portRange.start}-${config.portRange.end} so only the router reaches them,\n` +
        "  or set JP_PROJECT_BIND_ADDR=127.0.0.1 if the control plane and router run on the host\n" +
        "  rather than in containers. See docs/SECURITY.md.\n",
    );
  }

  const sweptSessions = auth.sweepExpiredSessions();
  if (sweptSessions > 0) logger.debug({ sweptSessions }, "expired sessions removed");

  worker.start();
  reconciler.start();
  dataPools.start();
  disk.start();
  controlPlaneBackups.start();
  metrics.start();

  // Backups chain — each run queues the next — so this only has to close the
  // hole a permanently failed run would leave. It also covers projects created
  // before this control plane started.
  const scheduleBackups = () => {
    try {
      backups.ensureScheduled();
    } catch (err) {
      logger.error({ err }, "could not schedule backups");
    }
  };
  scheduleBackups();
  setInterval(scheduleBackups, 15 * 60_000).unref();

  // Branches are made to be thrown away; the ones nobody throws away are the
  // ones that quietly fill a host.
  const expireBranches = () => {
    try {
      branches.expireDue((id, actor) => projects.delete(id, actor));
    } catch (err) {
      logger.error({ err }, "branch expiry sweep failed");
    }
  };
  expireBranches();
  setInterval(expireBranches, 10 * 60_000).unref();

  if (config.backups.restoreCheckIntervalHours > 0) {
    const scheduleRestoreChecks = () => {
      try {
        scheduleDueRestoreChecks(ctx);
      } catch (err) {
        logger.error({ err }, "could not schedule restore verification");
      }
    };
    scheduleRestoreChecks();
    setInterval(scheduleRestoreChecks, 60 * 60_000).unref();
  } else {
    logger.warn(
      "Restore verification is disabled (JP_RESTORE_CHECK_INTERVAL_HOURS=0). " +
        "Backups that have never been restored are a hypothesis, not a recovery plan.",
    );
  }

  // Docker being unreachable is reported, not fatal. This is the same argument
  // that puts control-plane metadata in SQLite (ARCHITECTURE §3): the process
  // whose job is to explain an outage must survive it.
  docker
    .ping()
    .then((v) => logger.info({ docker: v.serverVersion }, "docker reachable"))
    .catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "docker is not reachable; the control plane is up but cannot provision projects",
      ),
    );

  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info({ url: `http://${config.host}:${info.port}` }, "control plane listening");
  });

  installShutdownHandlers({ server, ctx });
}

/**
 * Queue a restore verification for any project whose last one is older than the
 * configured interval.
 */
function scheduleDueRestoreChecks(ctx: AppContext): void {
  const cutoff = Date.now() - ctx.config.backups.restoreCheckIntervalHours * 3600_000;

  for (const project of ctx.projects.list()) {
    if (project.state !== "running") continue;

    const config = ctx.backups.get(project.id);
    if (!config?.enabled || config.awaitingFirstBackup) continue;

    const pending = ctx.queue
      .list({ projectId: project.id, limit: 50 })
      .some((job) => job.type === "restore.verify" && (job.state === "queued" || job.state === "running"));
    if (pending) continue;

    const last = ctx.backups.listRestoreChecks(project.id, 1)[0];
    if (last && last.startedAt > cutoff) continue;

    ctx.queue.enqueue({
      type: "restore.verify",
      projectId: project.id,
      payload: { projectId: project.id },
      // Behind everything a user is waiting on; this is housekeeping.
      priority: -10,
      maxAttempts: 2,
    });
    ctx.logger.info({ ref: project.ref }, "queued restore verification");
  }
}

function installShutdownHandlers({ server, ctx }: { server: ServerType; ctx: AppContext }): void {
  const { logger, worker, db } = ctx;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, "second signal received; exiting immediately");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    // Order matters: stop taking new HTTP work, let in-flight jobs unwind and
    // hand their leases back, then close the database last so the release
    // writes actually land.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ctx.reconciler.stop();
    await worker.stop();
    await ctx.dataPools.stop();
    db.close();

    logger.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection");
    process.exit(1);
  });
}

main().catch((err) => {
  // The logger may not exist yet if config validation failed, so this path
  // deliberately uses console and a readable message.
  console.error(`\njustpostgres failed to start:\n\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
