import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { LSN_PATTERN, type Project } from "@justpostgres/shared";
import { backupForLsn } from "./pgbackrest.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { credentials, projects, type ProjectRow } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import type { DiskMonitor } from "../storage/disk.js";
import { recreateProjectContainer } from "../projects/container.js";
import {
  backupVolumeName,
  containerName,
  networkName,
  volumeName,
} from "../projects/naming.js";
import {
  generateProjectRef,
} from "../lib/crypto.js";
import { allocateHostPort } from "../projects/ports.js";
import { ProjectError, toProject } from "../projects/service.js";
import type { BackupService } from "./service.js";

export interface RestoreRequest {
  sourceProjectId: string;
  /** Epoch millis. Omitted (with no `targetLsn`) restores to the end of the WAL stream. */
  targetTime?: number;
  /** A Postgres log position. Exclusive with `targetTime`. */
  targetLsn?: string;
  name?: string;
}

export class RestoreService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly queue: JobQueue,
    private readonly backups: BackupService,
    private readonly logger: Logger,
    private readonly disk: DiskMonitor,
  ) {}

  /**
   * Start a restore.
   *
   * The result is a **new** project. This is the decision the whole milestone
   * turns on: nothing about the source project changes, so "restore to 14:32"
   * is something you can do while the original is still serving traffic, and
   * inspect before committing to. Nothing is destroyed until someone chooses to
   * delete it.
   */
  async start(request: RestoreRequest, actor: string): Promise<Project> {
    // A restore writes a second full copy of the database. Starting one on a
    // disk that cannot hold it is how a recovery turns into a second outage.
    this.disk.assertCanAllocate("restore into a new project");

    const source = this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, request.sourceProjectId), isNull(projects.deletedAt)))
      .get();
    if (!source) throw new ProjectError("not_found", "No such project.");

    const config = this.backups.get(source.id);
    if (!config) throw new ProjectError("invalid_state", "This project has no backup configuration.");
    if (config.awaitingFirstBackup) {
      throw new ProjectError(
        "invalid_state",
        "This project has no completed backup yet, so there is nothing to restore from.",
      );
    }

    // Check the requested point is actually inside the recovery window.
    //
    // Without this the request is accepted, a project row is created, a
    // container is provisioned, and pgBackRest fails minutes later with a
    // message about WAL segments — by which time the user has a failed project
    // to clean up and no idea what they did wrong. The case that makes this
    // urgent is a major-version upgrade: backups taken on the old version are
    // still sitting in the repository, so a plausible-looking timestamp from
    // last week refers to a backup that cannot restore into the version running
    // now.
    if (request.targetTime !== undefined && request.targetLsn !== undefined) {
      throw new ProjectError("invalid_request", "Choose a point in time or a log position, not both.");
    }
    if (request.targetTime !== undefined) {
      await this.assertWithinWindow(source.id, request.targetTime);
    }
    // The backup to start from is chosen now, not left to pgBackRest — see
    // backupForLsn for why it would otherwise pick wrong.
    const backupSet =
      request.targetLsn !== undefined ? await this.backupSetForLsn(source.id, request.targetLsn) : undefined;

    const credential = this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.projectId, source.id), eq(credentials.isPrimary, true)))
      .get();
    if (!credential) throw new ProjectError("not_found", "Source project has no stored credentials.");

    const ref = this.uniqueRef();
    const id = randomUUID();
    const hostPort = await allocateHostPort(this.db, this.config);
    const now = Date.now();

    const name =
      request.name?.trim() ||
      (request.targetLsn
        ? `${source.name}-restored-${request.targetLsn.replace("/", "-").toLowerCase()}`
        : `${source.name}-restored-${new Date(request.targetTime ?? now)
            .toISOString()
            .slice(11, 16)
            .replace(":", "")}`);

    const row = this.db.transaction((tx) => {
      const created = tx
        .insert(projects)
        .values({
          id,
          ref,
          name,
          pgMajor: source.pgMajor,
          // Same image as the source, always. A physical backup is tied to the
          // major version that wrote it, so restoring onto a different one
          // would fail in a confusing way at recovery rather than here.
          image: source.image,
          state: "creating",
          containerName: containerName(ref),
          volumeName: volumeName(ref),
          networkName: networkName(ref),
          backupVolumeName: backupVolumeName(ref),
          hostPort,
          memoryBytes: source.memoryBytes,
          nanoCpus: source.nanoCpus,
          // Inherited, not reset. A copy of a database that had pg_cron loaded
          // still contains pg_cron in its catalog, so starting it without the
          // library preloaded produces an extension whose functions all fail —
          // a copy that is subtly, silently not equivalent to its original.
          preloadLibraries: source.preloadLibraries,
          // A restore is a branch: same parent, same lineage, different point in
          // time. M5 presents this as forking; the engine is identical.
          parentProjectId: source.id,
          branchPoint: request.targetTime ?? now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      // The restored cluster contains the source's `pg_authid`, so its roles
      // keep the source's passwords. Generating a fresh one here would produce
      // a connection string that does not work.
      tx.insert(credentials)
        .values({
          id: randomUUID(),
          projectId: id,
          role: credential.role,
          database: credential.database,
          passwordEnc: credential.passwordEnc,
          isPrimary: true,
          createdAt: now,
        })
        .run();

      return created;
    });

    this.queue.enqueue({
      type: "restore.run",
      projectId: id,
      payload: {
        targetProjectId: id,
        sourceProjectId: source.id,
        ...(request.targetTime ? { targetTime: request.targetTime } : {}),
        ...(request.targetLsn ? { targetLsn: request.targetLsn, backupSet } : {}),
      },
      priority: 10,
      maxAttempts: 2,
    });

    this.logger.info(
      {
        target: ref,
        source: source.ref,
        targetTime: request.targetTime ?? null,
        targetLsn: request.targetLsn ?? null,
        actor,
      },
      "restore enqueued",
    );
    return toProject(row);
  }

  /**
   * Validate a log-position target and name the backup set to restore from.
   *
   * Only the lower bound is checked. A position past the end of the archive is
   * caught by the job, which restores everything instead — the same reading a
   * too-late timestamp gets, and almost always what was meant.
   */
  private async backupSetForLsn(projectId: string, lsn: string): Promise<string> {
    if (!LSN_PATTERN.test(lsn)) {
      throw new ProjectError("invalid_request", `"${lsn}" is not a log position; expected something like 16/B374D848.`);
    }
    const info = await this.backups.stanzaInfo(projectId).catch(() => null);
    const choice = backupForLsn(info ?? undefined, lsn);
    if (choice.ok) return choice.label;

    switch (choice.reason) {
      case "no_backups":
        throw new ProjectError("invalid_state", "There is no restorable backup for this project yet.");
      case "no_lsn_info":
        throw new ProjectError(
          "invalid_state",
          "The backup repository does not report log positions for its backups, so a log-position " +
            "restore cannot pick a starting backup. Restore to a point in time instead.",
        );
      case "before_window":
        throw new ProjectError(
          "invalid_request",
          `That log position is before the recovery window, which starts at ${choice.earliest}.`,
        );
    }
  }

  /**
   * Refuse a recovery target the repository cannot actually reach.
   *
   * `strandedByUpgrade` is called out separately because it is the one case
   * where the operator's mental model is right and the repository disagrees:
   * they *did* take a backup then, it *is* still there, and it still cannot be
   * used. Saying only "outside the window" would send them looking for a
   * deleted backup.
   */
  private async assertWithinWindow(projectId: string, targetTime: number): Promise<void> {
    const status = await this.backups.status(projectId).catch(() => null);
    const window = status?.window;
    if (!window || window.empty || window.earliest === null) {
      throw new ProjectError(
        "invalid_state",
        window && window.strandedByUpgrade > 0
          ? `Every backup in this repository was taken on an earlier Postgres major version and ` +
            `cannot restore into the version running now. Wait for the post-upgrade full backup.`
          : "There is no restorable backup for this project yet.",
      );
    }

    if (targetTime < window.earliest) {
      const stranded =
        window.strandedByUpgrade > 0
          ? ` ${window.strandedByUpgrade} older backup${window.strandedByUpgrade === 1 ? "" : "s"} ` +
            `exist${window.strandedByUpgrade === 1 ? "s" : ""} from before a major-version upgrade, but ` +
            `cannot restore into Postgres as it is running now.`
          : "";
      throw new ProjectError(
        "invalid_request",
        `That point in time is before the recovery window, which starts at ` +
          `${new Date(window.earliest).toISOString()}.${stranded}`,
      );
    }

    // A minute of slack: a user picking "now" in a browser is a round trip
    // behind the server, and refusing that would be pedantry.
    if (window.latest !== null && targetTime > window.latest + 60_000) {
      throw new ProjectError(
        "invalid_request",
        `That point in time is in the future of what the repository covers, which ends at ` +
          `${new Date(window.latest).toISOString()}.`,
      );
    }
  }

  /**
   * Swap two projects' public identity.
   *
   * A restore is only half a recovery: the new project holds the right data but
   * answers on a different hostname and port, so every application would still
   * need a config change to reach it. Promote exchanges the `ref` and published
   * port of the restored project and its source, so the restored data answers
   * where the application is already looking.
   *
   * Physical objects — containers, volumes, the pgBackRest stanza — keep their
   * original names. Renaming a volume is not a thing Docker does, and it does
   * not need to be: `ref` is a routing label, and the row records the physical
   * names separately.
   */
  async promote(restoredProjectId: string, actor: string): Promise<{ promoted: Project; demoted: Project }> {
    const restored = this.db.select().from(projects).where(eq(projects.id, restoredProjectId)).get();
    if (!restored || restored.deletedAt) throw new ProjectError("not_found", "No such project.");
    if (restored.state !== "running") {
      throw new ProjectError("invalid_state", `Project is ${restored.state}; only a running project can be promoted.`);
    }
    if (!restored.parentProjectId) {
      throw new ProjectError("invalid_state", "This project was not restored from another one.");
    }

    const source = this.db.select().from(projects).where(eq(projects.id, restored.parentProjectId)).get();
    if (!source || source.deletedAt) {
      throw new ProjectError("invalid_state", "The project this was restored from no longer exists.");
    }
    if (restored.sourceRepoVolumeName) {
      throw new ProjectError(
        "invalid_state",
        "This project is still finishing its restore. Wait for it to take its own first backup.",
      );
    }

    const now = Date.now();
    const swapped = this.db.transaction((tx) => {
      // A unique index on `ref` means the two cannot be swapped directly; park
      // one on a temporary value for the duration of the transaction.
      const parking = `swap-${restored.id.slice(0, 8)}`;
      tx.update(projects).set({ ref: parking, hostPort: null }).where(eq(projects.id, restored.id)).run();
      tx.update(projects)
        .set({ ref: restored.ref, hostPort: restored.hostPort, updatedAt: now })
        .where(eq(projects.id, source.id))
        .run();
      tx.update(projects)
        .set({ ref: source.ref, hostPort: source.hostPort, updatedAt: now })
        .where(eq(projects.id, restored.id))
        .run();

      return {
        promoted: tx.select().from(projects).where(eq(projects.id, restored.id)).get()!,
        demoted: tx.select().from(projects).where(eq(projects.id, source.id)).get()!,
      };
    });

    // Published ports are fixed when a container is created, so both have to be
    // recreated for the swap to take effect on the wire — and **both must be
    // released before either is recreated**. Recreating the promoted project
    // first fails with "port is already allocated", because the project it is
    // taking the port from is still holding it.
    //
    // That leaves a few seconds where neither is reachable. For a deliberate
    // cutover that is the right trade: the alternative is an intermediate state
    // where the old data is still being served on the production port.
    await this.releaseContainer(swapped.promoted);
    await this.releaseContainer(swapped.demoted);

    try {
      await this.startWithCurrentPort(swapped.promoted);
      await this.startWithCurrentPort(swapped.demoted);
    } catch (err) {
      this.logger.error({ err }, "promote failed while recreating containers");
      throw err;
    }

    const now2 = Date.now();
    this.db
      .update(projects)
      .set({ state: "running", lastError: null, updatedAt: now2 })
      .where(inArray(projects.id, [swapped.promoted.id, swapped.demoted.id]))
      .run();

    this.logger.info(
      { promoted: swapped.promoted.ref, demoted: swapped.demoted.ref, actor },
      "promoted a restored project into the source's identity",
    );

    return { promoted: toProject(swapped.promoted), demoted: toProject(swapped.demoted) };
  }

  /** Stop and remove a project's container, freeing its published port. */
  private async releaseContainer(row: ProjectRow): Promise<void> {
    if (!row.containerId) return;
    await this.docker.stopContainer(row.containerId, 30);
    await this.docker.removeContainer(row.containerId, { force: true });
  }

  /** Recreate and start a project's container on whatever port its row now says. */
  private async startWithCurrentPort(row: ProjectRow): Promise<void> {
    // Through the shared builder, so a promoted project keeps its
    // shared_preload_libraries and every other setting. Rebuilding the spec by
    // hand here is how a promote used to be able to silently drop an extension.
    await recreateProjectContainer(
      { db: this.db, config: this.config, docker: this.docker, backups: this.backups },
      row.id,
    );
  }

  private uniqueRef(): string {
    for (let i = 0; i < 10; i++) {
      const ref = generateProjectRef();
      const existing = this.db.select({ id: projects.id }).from(projects).where(eq(projects.ref, ref)).get();
      if (!existing) return ref;
    }
    throw new ProjectError("conflict", "Could not generate a unique project ref.");
  }
}
