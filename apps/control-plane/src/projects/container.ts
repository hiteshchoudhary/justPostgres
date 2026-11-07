import { and, eq } from "drizzle-orm";
import type { BackupService } from "../backups/service.js";
import { archivingPostgresArgs, backupEnv, REPO_MOUNT } from "../backups/pgbackrest.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { credentials, projects, type ProjectRow } from "../db/schema.js";
import type { ContainerSpec, DockerDriver } from "../docker/driver.js";
import { decryptSecret } from "../lib/crypto.js";
import {
  DATA_MOUNT,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  PGDATA,
  physicalNames,
  projectLabels,
  stanzaName,
} from "./naming.js";

export interface ProjectContainerOptions {
  /** Extra read-only mounts, e.g. a source project's repository during a restore. */
  readOnlyVolumes?: Record<string, string>;
  /**
   * Extra environment, e.g. a source repository's credentials while a restore
   * recovers. Merged after the defaults; dropped the next time the container is
   * rebuilt without it.
   */
  extraEnv?: Record<string, string>;
  /** Overrides the libraries stored on the project row. */
  preloadLibraries?: string[];
  /** Additional `-c name=value` settings appended after the defaults. */
  extraSettings?: Record<string, string>;
}

/**
 * The one place a project's container is described.
 *
 * There were four of these — provisioning, restore, branch and promote — each
 * assembling the same env, mounts, limits and Postgres flags by hand. Every new
 * setting had to be added to all four, and a setting that reached only three of
 * them produced a project that behaved differently depending on how it happened
 * to be created. That failure mode has already cost real bugs here (a restored
 * project silently missing its copy-on-write data directory), so the assembly
 * lives in exactly one function.
 */
export function buildProjectContainerSpec(
  deps: { db: Db; config: Config; backups: BackupService },
  project: ProjectRow,
  options: ProjectContainerOptions = {},
): ContainerSpec {
  const { db, config, backups } = deps;

  const credential = db
    .select()
    .from(credentials)
    .where(and(eq(credentials.projectId, project.id), eq(credentials.isPrimary, true)))
    .get();
  if (!credential) throw new Error(`Project ${project.ref} has no stored credentials.`);

  const names = physicalNames(project);
  // Stored, never derived from `ref`: promoting a restored project swaps refs
  // while its repository keeps the stanza it was created with.
  const stanza = backups.get(project.id)?.stanza ?? stanzaName(project.ref);

  const preload = options.preloadLibraries ?? parsePreload(project.preloadLibraries);

  return {
    name: names.container,
    image: project.image,
    env: {
      POSTGRES_USER: DEFAULT_ROLE,
      POSTGRES_PASSWORD: decryptSecret(credential.passwordEnc, config.masterKey),
      POSTGRES_DB: DEFAULT_DATABASE,
      PGDATA,
      // pgBackRest is configured entirely through the environment, so
      // archive_command inherits it from the Postgres process that spawns it.
      ...backupEnv({
        stanza,
        repo: backups.repoSpec(project.id, project.ref),
        retentionFull: config.backups.retentionFull,
      }),
      ...options.extraEnv,
    },
    labels: projectLabels(project.id, project.ref),
    volumes: { [names.volume]: DATA_MOUNT, [names.backupVolume]: REPO_MOUNT },
    ...(options.readOnlyVolumes ? { readOnlyVolumes: options.readOnlyVolumes } : {}),
    ports: project.hostPort ? { 5432: project.hostPort } : {},
    portBindAddress: config.projectBindAddr,
    network: names.network,
    command: [
      ...archivingPostgresArgs(stanza, config.backups.archiveTimeoutSeconds),
      ...preloadArgs(preload),
      ...Object.entries(options.extraSettings ?? {}).flatMap(([k, v]) => ["-c", `${k}=${v}`]),
    ],
    memoryBytes: project.memoryBytes,
    nanoCpus: project.nanoCpus,
    restartPolicy: "unless-stopped",
  };
}

/**
 * Stop, remove and recreate a project's container.
 *
 * Needed whenever something baked into the container at creation has to change:
 * a published port after a promote, or `shared_preload_libraries` after
 * enabling an extension that requires one. Both mean downtime, which is why
 * they are jobs the user is warned about rather than background work.
 */
export async function recreateProjectContainer(
  deps: { db: Db; config: Config; docker: DockerDriver; backups: BackupService },
  projectId: string,
  options: ProjectContainerOptions = {},
): Promise<string> {
  const { db, docker } = deps;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error("Project no longer exists.");

  if (project.containerId) {
    await docker.stopContainer(project.containerId, 30);
    await docker.removeContainer(project.containerId, { force: true });
  }

  const containerId = await docker.createContainer(
    buildProjectContainerSpec(deps, project, options),
  );
  await docker.startContainer(containerId);

  db.update(projects)
    .set({ containerId, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
    .run();

  return containerId;
}

/**
 * `shared_preload_libraries` is a startup-only setting: a library that is not
 * loaded when the postmaster starts cannot be loaded later, which is the whole
 * reason enabling `pg_cron` costs a restart.
 */
export function preloadArgs(libraries: string[]): string[] {
  if (libraries.length === 0) return [];
  return ["-c", `shared_preload_libraries=${[...new Set(libraries)].sort().join(",")}`];
}

export function parsePreload(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function serialisePreload(libraries: string[]): string {
  return JSON.stringify([...new Set(libraries)].sort());
}
