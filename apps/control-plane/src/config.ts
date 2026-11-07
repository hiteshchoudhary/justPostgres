import { randomBytes } from "node:crypto";
import { parseTrustedProxies, type TrustedProxies } from "./auth/trusted-proxy.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * All configuration arrives through the environment and is validated once, at
 * boot, before anything else starts. A misconfigured control plane should fail
 * immediately with a readable message rather than halfway through provisioning
 * someone's database.
 */

const booleanish = z
  .string()
  .transform((v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  JP_HOST: z.string().default("0.0.0.0"),
  JP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  JP_DATA_DIR: z.string().default("./data"),
  JP_LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  /**
   * AES-256-GCM key for credentials at rest, base64-encoded, exactly 32 bytes.
   * Nothing in M0 encrypts anything yet, but the key is validated from the
   * start so that a deployment cannot reach M1 and discover the problem while
   * holding real credentials.
   */
  JP_MASTER_KEY: z.string().optional(),

  /** Prefer a TCP socket proxy; fall back to the raw unix socket in local dev. */
  JP_DOCKER_HOST: z.string().optional(),
  JP_DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),

  /**
   * Hostname users connect their clients to. Not the same as JP_HOST, which is
   * only the interface the control plane's HTTP server binds.
   */
  JP_PUBLIC_HOST: z.string().default("localhost"),

  /** Host ports available to publish project containers on (routing mode 3). */
  /**
   * Interface project database ports are published on.
   *
   * The default publishes on every interface, which on a VPS with no firewall
   * means every project's Postgres is reachable from the internet on a high
   * port. It stays the default because a containerised router and control plane
   * reach projects through the host gateway, and loopback-only binding would
   * cut them off. Set it to 127.0.0.1 when both run on the host, and firewall
   * the range otherwise. See docs/SECURITY.md.
   */
  JP_PROJECT_BIND_ADDR: z.string().default("0.0.0.0"),
  JP_PORT_RANGE_START: z.coerce.number().int().min(1024).max(65535).default(55000),
  JP_PORT_RANGE_END: z.coerce.number().int().min(1024).max(65535).default(55999),

  /**
   * Where the router listens, as clients see it. When the router is not
   * deployed, the UI falls back to the project's own published port.
   */
  JP_ROUTER_ENABLED: booleanish.optional(),
  JP_ROUTER_PUBLIC_HOST: z.string().optional(),
  JP_ROUTER_SESSION_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  JP_ROUTER_POOL_PORT: z.coerce.number().int().min(1).max(65535).default(6543),

  /**
   * How the control plane reaches a project's Postgres to browse its data.
   * Projects publish on the host, so in Docker this is the host gateway.
   */
  JP_PROJECT_CONNECT_HOST: z.string().default("127.0.0.1"),
  // --- backups -------------------------------------------------------------
  /** Default repository type for new projects. */
  JP_BACKUP_REPO_TYPE: z.enum(["posix", "s3"]).default("posix"),
  JP_BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
  JP_BACKUP_FULL_EVERY_DAYS: z.coerce.number().int().min(1).default(7),
  JP_BACKUP_RETENTION_FULL: z.coerce.number().int().min(1).max(9999).default(4),
  /** How long a backup or restore may run before the job gives up. */
  JP_BACKUP_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(6 * 3600_000),
  /**
   * Postgres `archive_timeout`: the most seconds of committed work a host loss
   * can take with it. Below 5 the archive fills with forced, near-empty
   * segments faster than it buys anything.
   */
  JP_BACKUP_ARCHIVE_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  /** How often to prove a backup still restores. 0 disables it. */
  JP_RESTORE_CHECK_INTERVAL_HOURS: z.coerce.number().int().min(0).default(168),

  /** S3-compatible repository. Applies to every project when repo type is s3. */
  JP_BACKUP_S3_BUCKET: z.string().optional(),
  JP_BACKUP_S3_ENDPOINT: z.string().optional(),
  JP_BACKUP_S3_REGION: z.string().default("us-east-1"),
  JP_BACKUP_S3_KEY: z.string().optional(),
  JP_BACKUP_S3_SECRET: z.string().optional(),
  JP_BACKUP_S3_URI_STYLE: z.enum(["host", "path"]).default("host"),
  JP_BACKUP_S3_VERIFY_TLS: booleanish.optional(),

  // --- branching (M5) ------------------------------------------------------
  /**
   * Copy-on-write branching. `none` falls back to a point-in-time restore,
   * which works everywhere and is O(database size).
   */
  JP_COW_DRIVER: z.enum(["none", "btrfs", "zfs"]).default("none"),
  /**
   * A btrfs subvolume or ZFS dataset the operator has already mounted. Mounting
   * a filesystem is an operator's job; justpostgres only creates and snapshots
   * subvolumes inside it.
   */
  JP_COW_ROOT: z.string().optional(),
  /** Image used for the privileged helper that runs btrfs/zfs commands. */
  JP_COW_HELPER_IMAGE: z.string().optional(),

  /**
   * Disk headroom below which the host stops accepting work that allocates.
   *
   * Two thresholds, and the larger wins. A percentage alone is useless on a
   * 4 TB disk (10% is 400 GB of waste) and a fixed size alone is useless on a
   * 20 GB VPS (2 GB is a rounding error on one and a third of the other).
   */
  JP_DISK_MIN_FREE_PERCENT: z.coerce.number().min(0).max(90).default(10),
  JP_DISK_MIN_FREE_GB: z.coerce.number().min(0).default(2),
  /** How often free space is sampled. Cheap: one `df` in a short-lived container. */
  JP_DISK_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),

  /**
   * Backups of the control plane's own metadata store. 0 disables them.
   *
   * On by default and cheap — the file is megabytes, and losing it means the
   * databases keep running with nothing able to reach or manage them.
   */
  JP_CP_BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).default(6),
  JP_CP_BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
  JP_CP_BACKUP_DIR: z.string().optional(),
  /**
   * Restore the metadata store from this file at startup, if there is no
   * database already. Deliberately refuses to overwrite an existing one.
   */
  JP_RESTORE_CONTROL_PLANE_FROM: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),

  /** How long an unpinned branch lives before it is deleted. 0 disables expiry. */
  JP_BRANCH_TTL_HOURS: z.coerce.number().int().min(0).default(168),

  // --- REST API (M7) -------------------------------------------------------
  JP_REST_IMAGE: z.string().default("postgrest/postgrest:latest"),
  /**
   * Wildcard domain for the hostname form, `<ref>.api.example.com`. Without it
   * the path form `/rest/<ref>/` is the only address, which always works.
   */
  JP_REST_DOMAIN_SUFFIX: z.string().optional(),

  /** Statement timeout for anything the data browser issues. */
  JP_DATA_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  /** Hard cap on rows returned to the UI, whatever the query asked for. */
  JP_DATA_MAX_ROWS: z.coerce.number().int().min(10).max(100_000).default(1000),

  /** `{major}` is replaced with the project's Postgres major version. */
  JP_POSTGRES_IMAGE_TEMPLATE: z.string().default("hiteshchoudhary/justpostgres-postgres:{major}"),
  JP_DEFAULT_PG_MAJOR: z.coerce.number().int().default(17),
  JP_DEFAULT_PROJECT_MEMORY_MB: z.coerce.number().int().min(128).default(512),
  JP_DEFAULT_PROJECT_CPUS: z.coerce.number().min(0.1).max(64).default(1),
  /** How long to wait for a new project to accept connections before failing it. */
  JP_PROJECT_READY_TIMEOUT_MS: z.coerce.number().int().min(5000).default(120_000),

  /**
   * Proxies whose `X-Forwarded-For` is believed. Comma-separated IPs or CIDRs.
   *
   * Empty by default, which means the header is ignored and the socket address
   * is used. That default is the safe one: the login lockout is keyed on the
   * client address, so believing a forgeable header lets an attacker send a
   * different value per attempt and never be rate limited.
   */
  JP_TRUSTED_PROXIES: z.string().default(""),

  JP_SESSION_TTL_HOURS: z.coerce.number().int().min(1).default(720),
  /**
   * Preseeded token for claiming a fresh instance. Leave unset and one is
   * generated and printed to the log on first boot. Empty counts as unset:
   * docker compose passes `${JP_SETUP_TOKEN:-}` through as an empty string when
   * the operator has not set one, and refusing to boot over that would be
   * absurd.
   */
  JP_SETUP_TOKEN: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(16).optional(),
  ),
  /** Failed logins from one address before it is locked out. */
  JP_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  JP_LOGIN_LOCKOUT_MS: z.coerce.number().int().min(1000).default(60_000),

  JP_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(5000).default(30_000),

  JP_JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  JP_JOB_LEASE_TTL_MS: z.coerce.number().int().min(1000).default(30_000),
  JP_JOB_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(500).default(10_000),
  JP_JOB_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),

  /** Serve the built UI from disk. Disabled in dev, where Vite serves it. */
  JP_SERVE_UI: booleanish.optional(),
  JP_UI_DIR: z.string().default("./public"),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config {
  nodeEnv: RawConfig["NODE_ENV"];
  isProduction: boolean;
  host: string;
  port: number;
  dataDir: string;
  sqlitePath: string;
  logLevel: RawConfig["JP_LOG_LEVEL"];
  masterKey: Buffer;
  masterKeyIsEphemeral: boolean;
  docker: { host?: string; socketPath: string };
  publicHost: string;
  router: { enabled: boolean; host: string; sessionPort: number; poolPort: number };
  portRange: { start: number; end: number };
  projects: {
    imageTemplate: string;
    defaultPgMajor: number;
    defaultMemoryBytes: number;
    defaultNanoCpus: number;
    readyTimeoutMs: number;
  };
  auth: {
    sessionTtlMs: number;
    maxLoginAttempts: number;
    lockoutMs: number;
    setupToken: string | null;
    /** Proxies whose X-Forwarded-For is believed. Empty means believe nobody. */
    trustedProxies: TrustedProxies;
  };
  data: { connectHost: string; statementTimeoutMs: number; maxRows: number };
  backups: {
    repoType: "posix" | "s3";
    intervalHours: number;
    fullEveryDays: number;
    retentionFull: number;
    timeoutMs: number;
    archiveTimeoutSeconds: number;
    restoreCheckIntervalHours: number;
    s3: {
      bucket?: string;
      endpoint?: string;
      region: string;
      key?: string;
      secret?: string;
      uriStyle: "host" | "path";
      verifyTls: boolean;
    };
  };
  cow: { driver: "none" | "btrfs" | "zfs"; root: string | null; helperImage: string | null };
  disk: { minFreePercent: number; minFreeBytes: number; sampleIntervalMs: number };
  /** Interface project ports publish on. See JP_PROJECT_BIND_ADDR. */
  projectBindAddr: string;
  controlPlaneBackups: { intervalHours: number; keep: number; dir: string; restoreFrom: string | null };
  branches: { ttlHours: number };
  rest: { image: string; domainSuffix: string | null };
  reconcileIntervalMs: number;
  jobs: {
    pollIntervalMs: number;
    leaseTtlMs: number;
    heartbeatIntervalMs: number;
    concurrency: number;
  };
  ui: { serve: boolean; dir: string };
}

function parseMasterKey(
  raw: string | undefined,
  isProduction: boolean,
): { key: Buffer; ephemeral: boolean } {
  if (!raw) {
    if (isProduction) {
      throw new Error(
        "JP_MASTER_KEY is required in production. Generate one with:\n" +
          "  openssl rand -base64 32\n" +
          "Store it outside the database. If it is lost, every stored " +
          "credential becomes permanently unreadable.",
      );
    }
    // Development convenience only. Ephemeral by design: restarting the control
    // plane invalidates anything encrypted with it, which is the correct and
    // noisy failure mode for a key nobody meant to rely on.
    return { key: randomBytes(32), ephemeral: true };
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new Error("JP_MASTER_KEY is not valid base64.");
  }
  if (decoded.length !== 32) {
    throw new Error(
      `JP_MASTER_KEY must decode to exactly 32 bytes, got ${decoded.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return { key: decoded, ephemeral: false };
}

/**
 * Docker Desktop on macOS puts the socket under the user's home directory and
 * does not always create the /var/run symlink, so an unset JP_DOCKER_SOCKET
 * checks both rather than failing with a confusing ECONNREFUSED.
 */
function resolveDockerSocket(env: NodeJS.ProcessEnv, configured: string): string {
  if (env.JP_DOCKER_SOCKET) return configured;
  const candidates = [
    "/var/run/docker.sock",
    env.HOME ? resolve(env.HOME, ".docker/run/docker.sock") : null,
    env.HOME ? resolve(env.HOME, ".colima/default/docker.sock") : null,
  ].filter((p): p is string => p !== null);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return configured;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const c = parsed.data;
  if (c.JP_PORT_RANGE_END < c.JP_PORT_RANGE_START) {
    throw new Error("JP_PORT_RANGE_END must be greater than or equal to JP_PORT_RANGE_START.");
  }

  if (c.JP_COW_DRIVER !== "none" && !c.JP_COW_ROOT) {
    throw new Error(
      `JP_COW_DRIVER is "${c.JP_COW_DRIVER}" but JP_COW_ROOT is not set. Point it at a ` +
        "btrfs subvolume or ZFS dataset you have already mounted.",
    );
  }

  const isProduction = c.NODE_ENV === "production";
  const dataDir = resolve(c.JP_DATA_DIR);
  const { key, ephemeral } = parseMasterKey(c.JP_MASTER_KEY, isProduction);

  return {
    nodeEnv: c.NODE_ENV,
    isProduction,
    host: c.JP_HOST,
    port: c.JP_PORT,
    dataDir,
    sqlitePath: resolve(dataDir, "justpostgres.sqlite"),
    logLevel: c.JP_LOG_LEVEL,
    masterKey: key,
    masterKeyIsEphemeral: ephemeral,
    docker: { host: c.JP_DOCKER_HOST, socketPath: resolveDockerSocket(env, c.JP_DOCKER_SOCKET) },
    publicHost: c.JP_PUBLIC_HOST,
    router: {
      enabled: c.JP_ROUTER_ENABLED ?? false,
      host: c.JP_ROUTER_PUBLIC_HOST ?? c.JP_PUBLIC_HOST,
      sessionPort: c.JP_ROUTER_SESSION_PORT,
      poolPort: c.JP_ROUTER_POOL_PORT,
    },
    portRange: { start: c.JP_PORT_RANGE_START, end: c.JP_PORT_RANGE_END },
    projects: {
      imageTemplate: c.JP_POSTGRES_IMAGE_TEMPLATE,
      defaultPgMajor: c.JP_DEFAULT_PG_MAJOR,
      defaultMemoryBytes: c.JP_DEFAULT_PROJECT_MEMORY_MB * 1024 * 1024,
      defaultNanoCpus: Math.round(c.JP_DEFAULT_PROJECT_CPUS * 1e9),
      readyTimeoutMs: c.JP_PROJECT_READY_TIMEOUT_MS,
    },
    auth: {
      sessionTtlMs: c.JP_SESSION_TTL_HOURS * 3600 * 1000,
      maxLoginAttempts: c.JP_LOGIN_MAX_ATTEMPTS,
      lockoutMs: c.JP_LOGIN_LOCKOUT_MS,
      setupToken: c.JP_SETUP_TOKEN ?? null,
      // Parsed here so a malformed entry fails at boot rather than silently
      // matching nothing, which would fail open.
      trustedProxies: parseTrustedProxies(c.JP_TRUSTED_PROXIES),
    },
    data: {
      connectHost: c.JP_PROJECT_CONNECT_HOST,
      statementTimeoutMs: c.JP_DATA_STATEMENT_TIMEOUT_MS,
      maxRows: c.JP_DATA_MAX_ROWS,
    },
    backups: {
      repoType: c.JP_BACKUP_REPO_TYPE,
      intervalHours: c.JP_BACKUP_INTERVAL_HOURS,
      fullEveryDays: c.JP_BACKUP_FULL_EVERY_DAYS,
      retentionFull: c.JP_BACKUP_RETENTION_FULL,
      timeoutMs: c.JP_BACKUP_TIMEOUT_MS,
      archiveTimeoutSeconds: c.JP_BACKUP_ARCHIVE_TIMEOUT_SECONDS,
      restoreCheckIntervalHours: c.JP_RESTORE_CHECK_INTERVAL_HOURS,
      s3: {
        ...(c.JP_BACKUP_S3_BUCKET ? { bucket: c.JP_BACKUP_S3_BUCKET } : {}),
        ...(c.JP_BACKUP_S3_ENDPOINT ? { endpoint: c.JP_BACKUP_S3_ENDPOINT } : {}),
        region: c.JP_BACKUP_S3_REGION,
        ...(c.JP_BACKUP_S3_KEY ? { key: c.JP_BACKUP_S3_KEY } : {}),
        ...(c.JP_BACKUP_S3_SECRET ? { secret: c.JP_BACKUP_S3_SECRET } : {}),
        uriStyle: c.JP_BACKUP_S3_URI_STYLE,
        verifyTls: c.JP_BACKUP_S3_VERIFY_TLS ?? true,
      },
    },
    cow: {
      driver: c.JP_COW_DRIVER,
      root: c.JP_COW_ROOT ?? null,
      helperImage: c.JP_COW_HELPER_IMAGE ?? null,
    },
    projectBindAddr: c.JP_PROJECT_BIND_ADDR,
    disk: {
      minFreePercent: c.JP_DISK_MIN_FREE_PERCENT,
      minFreeBytes: Math.round(c.JP_DISK_MIN_FREE_GB * 1024 ** 3),
      sampleIntervalMs: c.JP_DISK_SAMPLE_INTERVAL_MS,
    },
    controlPlaneBackups: {
      intervalHours: c.JP_CP_BACKUP_INTERVAL_HOURS,
      keep: c.JP_CP_BACKUP_KEEP,
      dir: c.JP_CP_BACKUP_DIR ? resolve(c.JP_CP_BACKUP_DIR) : resolve(dataDir, "control-plane-backups"),
      restoreFrom: c.JP_RESTORE_CONTROL_PLANE_FROM ?? null,
    },
    branches: { ttlHours: c.JP_BRANCH_TTL_HOURS },
    rest: { image: c.JP_REST_IMAGE, domainSuffix: c.JP_REST_DOMAIN_SUFFIX ?? null },
    reconcileIntervalMs: c.JP_RECONCILE_INTERVAL_MS,
    jobs: {
      pollIntervalMs: c.JP_JOB_POLL_INTERVAL_MS,
      leaseTtlMs: c.JP_JOB_LEASE_TTL_MS,
      heartbeatIntervalMs: c.JP_JOB_HEARTBEAT_INTERVAL_MS,
      concurrency: c.JP_JOB_CONCURRENCY,
    },
    ui: { serve: c.JP_SERVE_UI ?? isProduction, dir: resolve(c.JP_UI_DIR) },
  };
}
