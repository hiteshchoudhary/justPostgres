import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { backupConfigs, backupRuns, projects, restoreChecks, type BackupConfigRow } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import type { JobQueue } from "../jobs/queue.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import type { Logger } from "../logger.js";
import type { ObjectStorageService } from "./object-storage.js";
import { stanzaName } from "../projects/naming.js";
import {
  backupEnv,
  parseInfo,
  recoveryWindow,
  REPO_MOUNT,
  repoSpecFor,
  runPgBackRest,
  type RecoveryWindow,
  type RepoSpec,
  type StanzaInfo,
} from "./pgbackrest.js";

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface BackupStatus {
  enabled: boolean;
  stanza: string;
  repoType: string;
  intervalHours: number;
  fullEveryDays: number;
  retentionFull: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  archivingHealthy: boolean | null;
  archivingCheckedAt: number | null;
  archivingError: string | null;
  awaitingFirstBackup: boolean;
  window: RecoveryWindow | null;
  stanzaInfo: StanzaInfo | null;
  /** The next scheduled run, if one is queued. */
  nextRunAt: number | null;
}

export class BackupService {
  /**
   * Set after construction, because object storage needs the Docker driver and
   * the driver is built alongside this service. Optional throughout: an install
   * that never configures object storage behaves exactly as it did before.
   */
  private objectStorage: ObjectStorageService | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
  ) {}

  useObjectStorage(service: ObjectStorageService): void {
    this.objectStorage = service;
  }

  /**
   * The repository a *new* project should use.
   *
   * Object storage configured in the UI wins over the environment. Existing
   * projects are untouched — their repository is stored on their own row, and
   * moving one is an explicit action with a new stanza and a fresh full backup,
   * because backups do not move when the pointer does.
   */
  private newProjectRepo(ref: string): RepoSpec | null {
    return this.objectStorage?.repoSpecFor(ref) ??
      (this.config.backups.repoType === "s3" ? repoSpecFor(this.config, ref) : null);
  }

  /** Create the backup configuration row for a new project. */
  initialise(projectId: string, ref: string): BackupConfigRow {
    const now = Date.now();
    const spec = this.newProjectRepo(ref);
    const repoConfig = spec ? JSON.stringify(spec) : null;

    return this.db
      .insert(backupConfigs)
      .values({
        projectId,
        enabled: true,
        stanza: stanzaName(ref),
        repoType: spec?.type ?? "posix",
        repoConfigEnc: repoConfig ? encryptSecret(repoConfig, this.config.masterKey) : null,
        intervalHours: this.config.backups.intervalHours,
        fullEveryDays: this.config.backups.fullEveryDays,
        retentionFull: this.config.backups.retentionFull,
        awaitingFirstBackup: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  get(projectId: string): BackupConfigRow | null {
    return this.db.select().from(backupConfigs).where(eq(backupConfigs.projectId, projectId)).get() ?? null;
  }

  /**
   * The repository for a project.
   *
   * Stored per project rather than derived fresh each time: if the operator
   * changes the global repository type later, existing projects must keep
   * pointing at the repository that actually holds their backups.
   */
  repoSpec(projectId: string, ref: string): RepoSpec {
    const row = this.get(projectId);
    if (row?.repoConfigEnc) {
      return JSON.parse(decryptSecret(row.repoConfigEnc, this.config.masterKey)) as RepoSpec;
    }
    // A row with no stored repository is a local-disk project: `initialise`
    // stores the spec whenever there is one to store. It must stay local.
    // Falling through to the *current* default here meant that configuring
    // object storage silently repointed every existing local project at the
    // bucket — its restores read a stanza that does not exist there, and the
    // next container rebuild (an extension, a promote) moved archive_command to
    // a repository with nothing in it.
    if (row) {
      return { type: "posix", path: REPO_MOUNT };
    }
    // No row yet — which is the normal case while a project is still being
    // provisioned, because the container is created before archiving is
    // initialised. Falling back to the *global* posix repository here would
    // build the container with local-disk archiving and then write a row
    // claiming object storage, leaving `archive_command` pointing somewhere the
    // rest of the system does not believe in.
    return this.newProjectRepo(ref) ?? repoSpecFor(this.config, ref);
  }

  env(projectId: string, ref: string, extra?: { sourceRepo?: { stanza: string; spec: RepoSpec } }) {
    const row = this.get(projectId);
    return backupEnv({
      stanza: row?.stanza ?? stanzaName(ref),
      repo: this.repoSpec(projectId, ref),
      retentionFull: row?.retentionFull ?? this.config.backups.retentionFull,
      ...(extra?.sourceRepo ? { sourceRepo: extra.sourceRepo } : {}),
    });
  }

  /** Read the authoritative state of the repository from pgBackRest itself. */
  async stanzaInfo(projectId: string): Promise<StanzaInfo | null> {
    const project = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project?.containerId) return null;

    const config = this.get(projectId);
    if (!config) return null;

    const result = await runPgBackRest(this.docker, project.containerId, [
      "info",
      "--output=json",
      `--stanza=${config.stanza}`,
    ]);
    if (!result.ok) return null;

    try {
      return parseInfo(result.stdout).find((s) => s.name === config.stanza) ?? null;
    } catch {
      return null;
    }
  }

  async status(projectId: string): Promise<BackupStatus | null> {
    const config = this.get(projectId);
    if (!config) return null;

    const stanzaInfo = await this.stanzaInfo(projectId).catch(() => null);
    const pending = this.queue
      .list({ projectId, state: "queued", limit: 20 })
      .filter((job) => job.type === "backup.run")
      .sort((a, b) => a.runAt - b.runAt)[0];

    return {
      enabled: config.enabled,
      stanza: config.stanza,
      repoType: config.repoType,
      intervalHours: config.intervalHours,
      fullEveryDays: config.fullEveryDays,
      retentionFull: config.retentionFull,
      lastRunAt: config.lastRunAt,
      lastSuccessAt: config.lastSuccessAt,
      lastError: config.lastError,
      archivingHealthy: config.archivingHealthy,
      archivingCheckedAt: config.archivingCheckedAt,
      archivingError: config.archivingError,
      awaitingFirstBackup: config.awaitingFirstBackup,
      window: stanzaInfo ? recoveryWindow(stanzaInfo, config.archivingHealthy !== false) : null,
      stanzaInfo,
      nextRunAt: pending?.runAt ?? null,
    };
  }

  /**
   * Decide whether the next run should be a full or an incremental.
   *
   * Incrementals are cheap but chain: restoring one needs every backup back to
   * its full. A periodic full bounds that chain, and bounds how much a single
   * corrupt incremental can cost.
   */
  async nextBackupType(projectId: string): Promise<"full" | "incr"> {
    const config = this.get(projectId);
    if (!config) return "full";

    const info = await this.stanzaInfo(projectId).catch(() => null);
    const lastFull = info?.backups.filter((b) => b.type === "full").sort((a, b) => b.finishedAt - a.finishedAt)[0];
    if (!lastFull) return "full";

    const ageDays = (Date.now() - lastFull.finishedAt) / 86_400_000;
    return ageDays >= config.fullEveryDays ? "full" : "incr";
  }

  /** Queue a backup now, or at a chosen time. */
  scheduleRun(projectId: string, opts: { type?: "full" | "incr"; runAt?: number } = {}): void {
    this.queue.enqueue({
      type: "backup.run",
      projectId,
      payload: { projectId, ...(opts.type ? { type: opts.type } : {}) },
      runAt: opts.runAt ?? Date.now(),
      maxAttempts: 3,
      priority: opts.runAt && opts.runAt > Date.now() ? 0 : 5,
    });
  }

  /**
   * Make sure every enabled project has a future backup queued.
   *
   * Backups chain — each successful run schedules the next — which is durable
   * but has one hole: if a run fails permanently, the chain stops and nothing
   * ever restarts it. This runs periodically and on boot to close it.
   */
  ensureScheduled(): number {
    const rows = this.db
      .select({ config: backupConfigs, project: projects })
      .from(backupConfigs)
      .innerJoin(projects, eq(projects.id, backupConfigs.projectId))
      .where(and(eq(backupConfigs.enabled, true), eq(projects.state, "running")))
      .all();

    let queued = 0;
    for (const { config, project } of rows) {
      if (project.deletedAt) continue;

      const pending = this.queue
        .list({ projectId: config.projectId, limit: 50 })
        .some((job) => job.type === "backup.run" && (job.state === "queued" || job.state === "running"));
      if (pending) continue;

      const due = (config.lastRunAt ?? 0) + config.intervalHours * 3600_000;
      this.scheduleRun(config.projectId, { runAt: Math.max(Date.now(), due) });
      queued++;
    }

    if (queued > 0) this.logger.info({ queued }, "queued missing backup runs");
    return queued;
  }

  recordRunStart(projectId: string, type: string, jobId: string, verification = false): string {
    const id = randomUUID();
    this.db
      .insert(backupRuns)
      .values({ id, projectId, jobId, type, status: "running", startedAt: Date.now(), verification })
      .run();
    return id;
  }

  recordRunEnd(
    runId: string,
    projectId: string,
    outcome: { ok: boolean; label?: string | null; sizeBytes?: number | null; error?: string },
  ): void {
    const now = Date.now();
    this.db
      .update(backupRuns)
      .set({
        status: outcome.ok ? "succeeded" : "failed",
        finishedAt: now,
        label: outcome.label ?? null,
        sizeBytes: outcome.sizeBytes ?? null,
        error: outcome.error ?? null,
      })
      .where(eq(backupRuns.id, runId))
      .run();

    this.db
      .update(backupConfigs)
      .set({
        lastRunAt: now,
        ...(outcome.ok ? { lastSuccessAt: now, lastError: null, awaitingFirstBackup: false } : {}),
        ...(outcome.ok ? {} : { lastError: outcome.error ?? "Backup failed." }),
        updatedAt: now,
      })
      .where(eq(backupConfigs.projectId, projectId))
      .run();
  }

  recordArchivingHealth(projectId: string, healthy: boolean, error?: string): void {
    this.db
      .update(backupConfigs)
      .set({
        archivingHealthy: healthy,
        archivingCheckedAt: Date.now(),
        archivingError: healthy ? null : (error ?? "WAL archiving is failing."),
        updatedAt: Date.now(),
      })
      .where(eq(backupConfigs.projectId, projectId))
      .run();
  }

  updateConfig(
    projectId: string,
    changes: {
      enabled?: boolean;
      intervalHours?: number;
      fullEveryDays?: number;
      retentionFull?: number;
    },
  ): void {
    this.db
      .update(backupConfigs)
      .set({ ...changes, updatedAt: Date.now() })
      .where(eq(backupConfigs.projectId, projectId))
      .run();

    // Re-enabling should not wait up to fifteen minutes for the next sweep.
    if (changes.enabled) this.ensureScheduled();
  }

  listRuns(projectId: string, limit = 20) {
    return this.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.projectId, projectId))
      .orderBy(desc(backupRuns.startedAt))
      .limit(limit)
      .all();
  }

  listRestoreChecks(projectId: string, limit = 10) {
    return this.db
      .select()
      .from(restoreChecks)
      .where(eq(restoreChecks.projectId, projectId))
      .orderBy(desc(restoreChecks.startedAt))
      .limit(limit)
      .all();
  }

  recordCheckStart(projectId: string): string {
    const id = randomUUID();
    this.db
      .insert(restoreChecks)
      .values({ id, projectId, status: "running", startedAt: Date.now() })
      .run();
    return id;
  }

  recordCheckEnd(id: string, outcome: { ok: boolean; detail?: string; error?: string }): void {
    this.db
      .update(restoreChecks)
      .set({
        status: outcome.ok ? "passed" : "failed",
        finishedAt: Date.now(),
        detail: outcome.detail ?? null,
        error: outcome.error ?? null,
      })
      .where(eq(restoreChecks.id, id))
      .run();
  }
}
