import { Hono } from "hono";
import { z } from "zod";
import { LSN_PATTERN } from "@justpostgres/shared";
import { clientIp } from "../../auth/middleware.js";
import { audit } from "../../lib/audit.js";
import { ProjectError } from "../../projects/service.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";
import { DiskSpaceError } from "../../storage/disk.js";

const restoreSchema = z.object({
  /** Epoch millis. Omitted restores to the end of the WAL stream. */
  targetTime: z.number().int().positive().optional(),
  /** A Postgres log position, e.g. `16/B374D848`. Exclusive with targetTime. */
  targetLsn: z
    .string()
    .trim()
    .regex(LSN_PATTERN, "Expected a log position like 16/B374D848.")
    .transform((lsn) => lsn.toUpperCase())
    .optional(),
  name: z.string().trim().min(1).max(64).optional(),
}).refine((body) => !(body.targetTime !== undefined && body.targetLsn !== undefined), {
  message: "Choose a point in time or a log position, not both.",
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  fullEveryDays: z.number().int().min(1).max(365).optional(),
  retentionFull: z.number().int().min(1).max(9999).optional(),
});

function toHttpError(err: unknown): never {
  if (err instanceof DiskSpaceError) {
    // 507 Insufficient Storage. The message is the operator's next action, so
    // it goes through to the client verbatim rather than being genericised.
    throw new HttpError(507, err.code, err.message);
  }
  if (err instanceof ProjectError) {
    // `invalid_request` is the client asking for something impossible — a
    // recovery point outside the window — which is a 400. `invalid_state` and
    // `conflict` are the server not being in a position to do it, which is a
    // 409. Collapsing both to 409 told a client to retry a request that will
    // never succeed.
    const status =
      err.code === "not_found" ? 404 : err.code === "invalid_request" ? 400 : 409;
    throw new HttpError(status, err.code, err.message);
  }
  throw err;
}

export function backupRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/:id/backups", async (c) => {
    const ctx = c.get("ctx");
    const projectId = c.req.param("id");
    try {
      const status = await ctx.backups.status(projectId);
      if (!status) throw HttpError.notFound("backup configuration");
      return c.json({
        status,
        runs: ctx.backups.listRuns(projectId, 20),
        checks: ctx.backups.listRestoreChecks(projectId, 10),
      });
    } catch (err) {
      toHttpError(err);
    }
  });

  /** Take a backup now, rather than waiting for the schedule. */
  app.post("/:id/backups/run", async (c) => {
    const body = z
      .object({ type: z.enum(["full", "incr"]).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const projectId = c.req.param("id");
    try {
      ctx.backups.scheduleRun(projectId, body.data.type ? { type: body.data.type } : {});
      audit(ctx.db.db, {
        actor: c.get("admin")!.email,
        action: "backup.run_requested",
        projectId,
        payload: { type: body.data.type ?? "auto" },
        ip: clientIp(c),
      });
      return c.json({ ok: true }, 202);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.patch("/:id/backups", async (c) => {
    const body = configSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const projectId = c.req.param("id");
    const existing = ctx.backups.get(projectId);
    if (!existing) throw HttpError.notFound("backup configuration");

    ctx.backups.updateConfig(projectId, body.data);
    audit(ctx.db.db, {
      actor: c.get("admin")!.email,
      action: "backup.config_changed",
      projectId,
      payload: body.data,
      ip: clientIp(c),
    });
    return c.json({ status: await ctx.backups.status(projectId) });
  });

  /**
   * Restore to a point in time.
   *
   * Always produces a new project. The source is untouched, so this is safe to
   * run against a database that is still serving traffic.
   */
  app.post("/:id/restore", async (c) => {
    // An empty body legitimately means "restore everything". A body that is
    // not JSON must not mean the same thing: falling back to `{}` turned a
    // malformed point-in-time request into a full restore — a whole new
    // project, built from the end of the archive the caller did not ask for.
    const raw = await c.req.text();
    let parsed: unknown = {};
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "bad_request", "The request body is not valid JSON.");
      }
    }
    const body = restoreSchema.safeParse(parsed);
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const project = await ctx.restores.start(
        { sourceProjectId: c.req.param("id"), ...body.data },
        admin.email,
      );
      audit(ctx.db.db, {
        actor: admin.email,
        action: "restore.started",
        projectId: c.req.param("id"),
        payload: {
          into: project.id,
          ref: project.ref,
          targetTime: body.data.targetTime ?? null,
          targetLsn: body.data.targetLsn ?? null,
        },
        ip: clientIp(c),
      });
      return c.json({ project }, 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  /** Swap this project's public identity with the one it was restored from. */
  app.post("/:id/promote", async (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const result = await ctx.restores.promote(c.req.param("id"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "project.promoted",
        projectId: c.req.param("id"),
        payload: { promoted: result.promoted.ref, demoted: result.demoted.ref },
        ip: clientIp(c),
      });
      return c.json(result);
    } catch (err) {
      toHttpError(err);
    }
  });

  /** Prove a backup restores, on demand rather than waiting for the schedule. */
  /**
   * Move this project's backups to the instance's object storage.
   *
   * A job, not an inline change: it restarts the database, creates a stanza in
   * the bucket, proves archiving reaches it, and takes a full backup — because
   * repointing without a backup would leave the project with a repository that
   * contains nothing and a UI that says backups are configured.
   */
  app.post("/:id/backups/migrate", (c) => {
    const ctx = c.get("ctx");
    const projectId = c.req.param("id");

    if (!ctx.objectStorage.isConfigured()) {
      throw new HttpError(
        409,
        "storage_not_configured",
        "Object storage is not set up for this instance. Configure it under Instance first.",
      );
    }

    const config = ctx.backups.get(projectId);
    if (!config) throw HttpError.notFound("backup configuration");
    // A move that failed partway leaves the project pointed at the bucket but
    // with no backup in it (`awaitingFirstBackup`). That has to be retryable:
    // refusing every project whose type already reads "s3" left a failed move
    // stuck for good, unprotected, with no button to finish it.
    if (config.repoType === "s3" && !config.awaitingFirstBackup) {
      throw new HttpError(409, "already_migrated", "This project already backs up to object storage.");
    }
    const inFlight = ctx.queue
      .list({ projectId, limit: 50 })
      .some((job) => job.type === "backup.migrate" && (job.state === "queued" || job.state === "running"));
    if (inFlight) {
      throw new HttpError(409, "conflict", "This project's backups are already being moved.");
    }

    const job = ctx.queue.enqueue({
      type: "backup.migrate",
      projectId,
      payload: { projectId },
      priority: 8,
      // Every step is checkpointed and safe to repeat, so a transient failure
      // (the bucket briefly unreachable, a slow restart) retries instead of
      // stranding the project half-moved.
      maxAttempts: 3,
    });

    audit(ctx.db.db, {
      actor: c.get("admin")!.email,
      action: "backup.migrated_to_object_storage",
      projectId,
      ip: clientIp(c),
    });

    return c.json({ jobId: job.id }, 202);
  });

  app.post("/:id/backups/verify", (c) => {
    const ctx = c.get("ctx");
    const projectId = c.req.param("id");

    ctx.queue.enqueue({
      type: "restore.verify",
      projectId,
      payload: { projectId },
      priority: 1,
      maxAttempts: 1,
    });
    audit(ctx.db.db, {
      actor: c.get("admin")!.email,
      action: "backup.verify_requested",
      projectId,
      ip: clientIp(c),
    });
    return c.json({ ok: true }, 202);
  });

  return app;
}
