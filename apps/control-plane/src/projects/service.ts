import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type {
  CreateProjectRequest,
  Project,
  ProjectConnection,
  ProjectRuntime,
  ProjectState,
} from "@justpostgres/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { credentials, projects, type ProjectRow } from "../db/schema.js";
import type { DockerDriver } from "../docker/driver.js";
import type { JobQueue } from "../jobs/queue.js";
import {
  decryptSecret,
  encryptSecret,
  generateDatabasePassword,
  generateProjectRef,
} from "../lib/crypto.js";
import type { Logger } from "../logger.js";
import type { DiskMonitor } from "../storage/disk.js";
import {
  buildEndpoints,
  containerName,
  DEFAULT_DATABASE,
  DEFAULT_ROLE,
  imageFor,
  networkName,
  volumeName,
} from "./naming.js";
import { allocateHostPort } from "./ports.js";

export class ProjectError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_state" | "conflict" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    pgMajor: row.pgMajor,
    image: row.image,
    state: row.state as ProjectState,
    lastError: row.lastError,
    hostPort: row.hostPort,
    memoryBytes: row.memoryBytes,
    nanoCpus: row.nanoCpus,
    parentProjectId: row.parentProjectId,
    branchPoint: row.branchPoint,
    branchMethod: row.branchMethod,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const MAX_MEMORY_MB = 1024 * 64;
const MAX_CPUS = 32;

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly docker: DockerDriver,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly disk: DiskMonitor,
  ) {}

  list(): Project[] {
    return this.db
      .select()
      .from(projects)
      .where(isNull(projects.deletedAt))
      .orderBy(desc(projects.createdAt))
      .all()
      .map(toProject);
  }

  getRow(id: string): ProjectRow {
    const row = this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt)))
      .get();
    if (!row) throw new ProjectError("not_found", "No such project.");
    return row;
  }

  get(id: string): Project {
    return toProject(this.getRow(id));
  }

  /**
   * Create a project.
   *
   * The row and its credentials are written synchronously so the UI has
   * something to show immediately, and the slow part — pulling an image,
   * creating a volume, waiting for Postgres to accept connections — runs as a
   * resumable job. A create interrupted by a control-plane restart continues
   * from its last completed step rather than starting over.
   */
  async create(req: CreateProjectRequest, actor: string): Promise<Project> {
    // Before anything is written. A project created on a full disk fails
    // halfway through initdb and leaves a broken row and an orphaned volume to
    // clean up, so the refusal belongs here rather than in the job.
    this.disk.assertCanAllocate("create a project");

    const name = req.name.trim();
    if (!name) throw new ProjectError("invalid_request", "Project name is required.");

    const pgMajor = req.pgMajor ?? this.config.projects.defaultPgMajor;
    const memoryBytes = req.memoryMb
      ? Math.min(req.memoryMb, MAX_MEMORY_MB) * 1024 * 1024
      : this.config.projects.defaultMemoryBytes;
    const nanoCpus = req.cpus
      ? Math.round(Math.min(req.cpus, MAX_CPUS) * 1e9)
      : this.config.projects.defaultNanoCpus;

    const ref = this.uniqueRef();
    const id = randomUUID();
    const hostPort = await allocateHostPort(this.db, this.config);
    const password = generateDatabasePassword();
    const now = Date.now();

    const row = this.db.transaction((tx) => {
      const created = tx
        .insert(projects)
        .values({
          id,
          ref,
          name,
          pgMajor,
          image: imageFor(this.config, pgMajor),
          state: "creating",
          containerName: containerName(ref),
          volumeName: volumeName(ref),
          networkName: networkName(ref),
          hostPort,
          memoryBytes,
          nanoCpus,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      tx.insert(credentials)
        .values({
          id: randomUUID(),
          projectId: id,
          role: DEFAULT_ROLE,
          database: DEFAULT_DATABASE,
          passwordEnc: encryptSecret(password, this.config.masterKey),
          isPrimary: true,
          createdAt: now,
        })
        .run();

      return created;
    });

    this.queue.enqueue({
      type: "project.create",
      projectId: id,
      payload: { projectId: id },
      // Provisioning is what the user is staring at; it goes ahead of
      // housekeeping work in the queue.
      priority: 10,
      maxAttempts: 3,
    });

    this.logger.info({ projectId: id, ref, pgMajor, actor }, "project create enqueued");
    return toProject(row);
  }

  /** Soft-delete immediately, tear down the runtime in a job. */
  delete(id: string, actor: string): Project {
    const row = this.getRow(id);
    if (row.state === "deleting") return toProject(row);

    const updated = this.db
      .update(projects)
      .set({ state: "deleting", updatedAt: Date.now() })
      .where(eq(projects.id, id))
      .returning()
      .get();

    this.queue.enqueue({
      type: "project.delete",
      projectId: id,
      payload: { projectId: id },
      priority: 5,
      maxAttempts: 5,
    });

    this.logger.info({ projectId: id, ref: row.ref, actor }, "project delete enqueued");
    return toProject(updated);
  }

  /**
   * Start, stop and restart run inline rather than as jobs.
   *
   * They take seconds and the user is waiting on the result, so the durability
   * a job buys is not worth the indirection. Create and delete are jobs because
   * they are slow and destructive; these are neither.
   */
  async setRunning(id: string, action: "start" | "stop" | "restart"): Promise<Project> {
    const row = this.getRow(id);

    if (row.state === "creating" || row.state === "deleting") {
      throw new ProjectError(
        "invalid_state",
        `Project is ${row.state}; wait for that to finish first.`,
      );
    }
    if (!row.containerId) {
      throw new ProjectError("invalid_state", "Project has no container to act on.");
    }

    if (action === "stop") {
      await this.docker.stopContainer(row.containerId);
    } else if (action === "start") {
      await this.docker.startContainer(row.containerId);
    } else {
      await this.docker.stopContainer(row.containerId);
      await this.docker.startContainer(row.containerId);
    }

    const state: ProjectState = action === "stop" ? "stopped" : "running";
    const updated = this.db
      .update(projects)
      .set({ state, lastError: null, updatedAt: Date.now() })
      .where(eq(projects.id, id))
      .returning()
      .get();

    return toProject(updated);
  }

  /**
   * Connection details.
   *
   * The password is only decrypted when `reveal` is set, so the ordinary list
   * and detail views never move it over the wire. The masked URL is always
   * safe to render.
   */
  connection(
    id: string,
    opts: { reveal?: boolean; requestHost?: string | null } = {},
  ): ProjectConnection {
    const row = this.getRow(id);

    const credential = this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.projectId, id), eq(credentials.isPrimary, true)))
      .get();
    if (!credential) throw new ProjectError("not_found", "Project has no stored credentials.");

    const endpoints = buildEndpoints({
      config: this.config,
      ref: row.ref,
      role: credential.role,
      password: decryptSecret(credential.passwordEnc, this.config.masterKey),
      database: credential.database,
      containerPort: row.hostPort,
      reveal: opts.reveal ?? false,
      requestHost: opts.requestHost ?? null,
    });

    if (endpoints.length === 0) {
      throw new ProjectError("invalid_state", "Project has no reachable endpoint yet.");
    }
    return { endpoints };
  }

  /** Live container state, for the detail view and the reconciler. */
  async runtime(id: string): Promise<ProjectRuntime> {
    const row = this.getRow(id);
    if (!row.containerId) {
      return { containerExists: false, running: false, status: null, startedAt: null };
    }

    const info = await this.docker.inspectContainer(row.containerId);
    if (!info) return { containerExists: false, running: false, status: null, startedAt: null };

    return {
      containerExists: true,
      running: info.running,
      status: info.status,
      startedAt: info.startedAt,
    };
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
