import type { ConnectionEndpoint } from "@justpostgres/shared";
import type { Config } from "../config.js";

/**
 * Every Docker object justpostgres creates is named from the project ref, and
 * carries labels identifying it. The reconciler relies on both: names make the
 * objects recognisable to a human running `docker ps`, labels make them
 * findable by the control plane.
 */

export const containerName = (ref: string) => `jp-${ref}`;
export const volumeName = (ref: string) => `jp-${ref}-data`;
export const networkName = (ref: string) => `jp-${ref}`;
export const backupVolumeName = (ref: string) => `jp-${ref}-backup`;

/** pgBackRest stanza name. The ref, so two projects can never collide. */
export const stanzaName = (ref: string) => ref;

export interface PhysicalNames {
  container: string;
  volume: string;
  network: string;
  backupVolume: string;
}

/**
 * The Docker objects a project actually owns.
 *
 * Read from the row rather than derived from `ref`, because promoting a
 * restored project swaps refs between two projects while their containers and
 * volumes stay exactly where they are. Deriving names from `ref` after a
 * promote would point at the other project's data — which is as bad as it
 * sounds. Derivation remains only as a fallback for rows written before these
 * columns existed.
 */
export function physicalNames(row: {
  ref: string;
  containerName?: string | null;
  volumeName?: string | null;
  networkName?: string | null;
  backupVolumeName?: string | null;
}): PhysicalNames {
  return {
    container: row.containerName ?? containerName(row.ref),
    volume: row.volumeName ?? volumeName(row.ref),
    network: row.networkName ?? networkName(row.ref),
    backupVolume: row.backupVolumeName ?? backupVolumeName(row.ref),
  };
}

/** Mount point of the project's volume. */
export const DATA_MOUNT = "/var/lib/postgresql/data";

/**
 * PGDATA is set explicitly to a subdirectory of the mount, and that is not
 * cosmetic. The official images disagree about the default: Postgres 18 moved
 * it, so a volume mounted at the 16/17 default initialises an empty cluster on
 * 18. Pinning PGDATA ourselves makes every supported major behave identically,
 * and the subdirectory also keeps initdb away from a `lost+found` at the root
 * of the volume.
 */
export const PGDATA = `${DATA_MOUNT}/pgdata`;

export const DEFAULT_ROLE = "postgres";
export const DEFAULT_DATABASE = "postgres";

export function imageFor(config: Config, pgMajor: number): string {
  return config.projects.imageTemplate.replace("{major}", String(pgMajor));
}

export function projectLabels(projectId: string, ref: string): Record<string, string> {
  return {
    "io.justpostgres.managed": "true",
    "io.justpostgres.project-id": projectId,
    "io.justpostgres.project-ref": ref,
    "io.justpostgres.role": "postgres",
  };
}

/**
 * Build every connection string a project offers.
 *
 * There are up to three, and which one a user should reach for is not obvious
 * from the URL alone — so each carries its purpose and, where it matters, the
 * rule that will bite them. Handing someone a pooled string with no warning
 * that `SET` does not persist is how a pooler earns a bad reputation for
 * "random" bugs.
 */
export function buildEndpoints(opts: {
  config: Config;
  ref: string;
  role: string;
  password: string;
  database: string;
  containerPort: number | null;
  reveal: boolean;
  /** Host the UI was reached on; used wherever no host is pinned in config. */
  requestHost?: string | null;
}): ConnectionEndpoint[] {
  const { config, ref, role, password, database, containerPort, reveal } = opts;
  const fallback = opts.requestHost ?? "localhost";
  const routerHost = config.router.host ?? fallback;
  const publicHost = config.publicHost ?? fallback;

  const make = (
    kind: ConnectionEndpoint["kind"],
    label: string,
    description: string,
    host: string,
    port: number,
    user: string,
    caveat?: string,
  ): ConnectionEndpoint => {
    const url = (secret: string) =>
      `postgresql://${user}:${secret}@${host}:${port}/${database}`;
    const base: ConnectionEndpoint = {
      kind,
      label,
      description,
      host,
      port,
      user,
      database,
      maskedUrl: url("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"),
      ...(caveat ? { caveat } : {}),
    };
    return reveal ? { ...base, url: url(password), psql: `psql "${url(password)}"` } : base;
  };

  const endpoints: ConnectionEndpoint[] = [];

  if (config.router.enabled) {
    // Through the router, the project is identified by the username suffix, so
    // both of these work from anywhere without per-project DNS or ports.
    const routedUser = `${role}.${ref}`;

    endpoints.push(
      make(
        "direct",
        "Direct",
        "Session mode. Use for migrations, pg_dump, LISTEN/NOTIFY, and long-lived application connections.",
        routerHost,
        config.router.sessionPort,
        routedUser,
      ),
    );

    endpoints.push(
      make(
        "pooled",
        "Pooled",
        "Transaction mode. Use for serverless and anything that opens many short-lived connections.",
        routerHost,
        config.router.poolPort,
        routedUser,
        "Session state does not survive a transaction: SET, LISTEN, session advisory locks, WITH HOLD cursors and named prepared statements will not work. Use the direct string for those.",
      ),
    );
  }

  if (containerPort !== null) {
    endpoints.push(
      make(
        "container",
        config.router.enabled ? "Container port" : "Direct",
        config.router.enabled
          ? "Bypasses the router entirely and talks to the container. Useful for debugging the router itself."
          : "Session mode, straight to the container. The router is not deployed on this instance.",
        publicHost,
        containerPort,
        role,
      ),
    );
  }

  return endpoints;
}

/**
 * The host a browser used to reach the UI, fit to put in a connection string.
 *
 * A proxy's X-Forwarded-Host wins over Host, because behind one the Host header
 * is the proxy's upstream address. The port is dropped — it is the UI's port,
 * not Postgres's. Anything that is not a plain hostname, IPv4 or bracketed
 * IPv6 address is refused rather than spliced into a URL.
 *
 * Trusting a client-supplied header is fine here: the answer goes back only to
 * the admin who sent it, so all a forged header can change is what that admin
 * sees.
 */
export function requestHostname(headers: {
  host?: string | null;
  forwardedHost?: string | null;
}): string | null {
  const forwarded = headers.forwardedHost?.split(",")[0]?.trim();
  const raw = (forwarded || headers.host || "").trim().toLowerCase();
  if (!raw) return null;

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    const v6 = raw.slice(0, end + 1);
    return /^\[[0-9a-f:.]+\]$/.test(v6) ? v6 : null;
  }

  const name = raw.replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name) ? name : null;
}
