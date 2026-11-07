export interface RecoveryWindow {
  /** Earliest restorable point: the end of the oldest surviving backup. */
  earliest: number | null;
  /**
   * Backups in the repository that belong to an older Postgres major version.
   *
   * They exist, they take up space, and they cannot restore into the cluster
   * that is running now — pgBackRest keeps them after a `stanza-upgrade`, and
   * counting them towards the recovery window would advertise a recovery point
   * that does not exist. Reported separately so the UI can say so plainly.
   */
  strandedByUpgrade: number;
  /**
   * Latest restorable point. Tracks the present while WAL archiving is
   * healthy, and falls back to the newest backup when it is not — claiming
   * otherwise would be a lie with consequences.
   */
  latest: number | null;
  backupCount: number;
  empty: boolean;
}

export interface BackupSetInfo {
  label: string;
  type: "full" | "diff" | "incr";
  /**
   * pgBackRest's database history id. Increments on `stanza-upgrade`, so a
   * backup whose id is not the stanza's current one was taken on a Postgres
   * major version this cluster is no longer running.
   */
  dbId: number;
  startedAt: number;
  finishedAt: number;
  repoSizeBytes: number;
  databaseSizeBytes: number;
  walStart: string | null;
  walStop: string | null;
  /**
   * Log positions the backup spans, as Postgres prints them (`16/B374D848`).
   * A restore to a log position needs a backup that *stopped* at or before it.
   */
  lsnStart: string | null;
  lsnStop: string | null;
}

export interface StanzaInfo {
  name: string;
  status: { code: number; message: string };
  backups: BackupSetInfo[];
  archive: Array<{ min: string | null; max: string | null }>;
  /** Postgres version history for this stanza, oldest first. */
  history: Array<{ id: number; version: string }>;
  /** The history entry the running cluster belongs to. */
  currentDbId: number | null;
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
  /** Null until the first check has run. */
  archivingHealthy: boolean | null;
  archivingCheckedAt: number | null;
  archivingError: string | null;
  awaitingFirstBackup: boolean;
  window: RecoveryWindow | null;
  stanzaInfo: StanzaInfo | null;
  nextRunAt: number | null;
}

export interface BackupRun {
  id: string;
  projectId: string;
  type: string;
  label: string | null;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  sizeBytes: number | null;
  error: string | null;
  verification: boolean;
}

export interface RestoreCheck {
  id: string;
  projectId: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  detail: string | null;
  error: string | null;
}

export interface RestoreRequest {
  /** Epoch millis. Omitted (with no `targetLsn`) restores to the end of the WAL stream. */
  targetTime?: number;
  /**
   * A Postgres log position (`16/B374D848`), e.g. from `pg_current_wal_lsn()`
   * or a log line. Precise where a timestamp is not: it can stop between two
   * transactions that committed in the same second. Exclusive with `targetTime`.
   */
  targetLsn?: string;
  name?: string;
}

/** The text form of a Postgres LSN: two hex numbers of up to 8 digits. */
export const LSN_PATTERN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/;

/**
 * Where backups are written, when they are not written to a local directory.
 *
 * Three providers rather than one generic form, because the difference between
 * them is entirely in the fields a person has to find and the mistakes they
 * make filling them in. Cloudflare R2 in particular has one endpoint shape, one
 * region value and one URI style that work, and asking someone to know that is
 * how a backup silently never happens.
 */
export const STORAGE_PROVIDERS = ["s3", "r2", "s3_compatible"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/** What the API returns. The secret key is never sent back. */
export interface ObjectStorageSettings {
  provider: StorageProvider;
  bucket: string;
  /** A prefix inside the bucket, so one bucket can hold several instances. */
  prefix: string;
  region: string;
  /** Hostname only, no scheme. Derived for R2, defaulted for AWS. */
  endpoint: string | null;
  port: number | null;
  /** Cloudflare account id — R2 only; the endpoint is built from it. */
  accountId: string | null;
  uriStyle: "host" | "path";
  verifyTls: boolean;
  accessKeyId: string;
  /** Always masked in responses. */
  secretAccessKeySet: boolean;
  updatedAt: number | null;
  /** Result of the last connection test, if one has been run. */
  lastTest: StorageTestResult | null;
}

export interface StorageTestResult {
  ok: boolean;
  detail: string;
  at: number;
}

/** What the UI sends. `secretAccessKey` may be omitted to keep the stored one. */
export interface ObjectStorageInput {
  provider: StorageProvider;
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string | null;
  port?: number | null;
  accountId?: string | null;
  uriStyle?: "host" | "path";
  verifyTls?: boolean;
  accessKeyId: string;
  secretAccessKey?: string;
}
