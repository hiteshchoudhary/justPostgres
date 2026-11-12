import { Hono } from "hono";
import { z } from "zod";
import { PG_MAJOR_VERSIONS, PROJECT_ACTIONS } from "@justpostgres/shared";
import { clientIp } from "../../auth/middleware.js";
import { audit, listAudit } from "../../lib/audit.js";
import { NoPortsAvailableError } from "../../projects/ports.js";
import { requestHostname } from "../../projects/naming.js";
import { ProjectError } from "../../projects/service.js";
import type { HonoEnv } from "../context.js";
import { HttpError } from "../errors.js";
import { DiskSpaceError } from "../../storage/disk.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  pgMajor: z
    .union(PG_MAJOR_VERSIONS.map((v) => z.literal(v)) as [z.ZodLiteral<16>, z.ZodLiteral<17>, z.ZodLiteral<18>])
    .optional(),
  memoryMb: z.number().int().min(128).max(65536).optional(),
  cpus: z.number().min(0.1).max(32).optional(),
});

function toHttpError(err: unknown): never {
  if (err instanceof DiskSpaceError) {
    // 507 Insufficient Storage. The message is the operator's next action, so
    // it goes through to the client verbatim rather than being genericised.
    throw new HttpError(507, err.code, err.message);
  }
  if (err instanceof ProjectError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "invalid_state" ? 409 : 400;
    throw new HttpError(status, err.code, err.message);
  }
  if (err instanceof NoPortsAvailableError) {
    throw new HttpError(507, "no_ports_available", err.message);
  }
  throw err;
}

export function projectRoutes() {
  const app = new Hono<HonoEnv>();

  app.get("/", (c) => c.json({ projects: c.get("ctx").projects.list() }));

  app.post("/", async (c) => {
    const body = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw HttpError.badRequest(body.error);

    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const project = await ctx.projects.create(body.data, admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "project.create",
        projectId: project.id,
        payload: { name: project.name, pgMajor: project.pgMajor, ref: project.ref },
        ip: clientIp(c),
      });
      return c.json({ project }, 201);
    } catch (err) {
      toHttpError(err);
    }
  });

  app.get("/:id", async (c) => {
    const ctx = c.get("ctx");
    try {
      const project = ctx.projects.get(c.req.param("id"));
      // Runtime facts come from Docker, so a project whose container died
      // between reconcile passes still reads truthfully on this page.
      const runtime = await ctx.projects.runtime(project.id).catch(() => null);
      return c.json({ project, runtime });
    } catch (err) {
      toHttpError(err);
    }
  });

  /**
   * The password is only decrypted when `?reveal=true` is passed, so it never
   * rides along with an ordinary page load and never lands in a log line from
   * a route that did not ask for it.
   */
  app.get("/:id/connection", (c) => {
    const ctx = c.get("ctx");
    const reveal = new URL(c.req.url).searchParams.get("reveal") === "true";
    try {
      // Connection strings name the host the admin reached this UI on, unless
      // JP_PUBLIC_HOST pins one: browse by IP, copy an IP; by domain, a domain.
      const requestHost = requestHostname({
        host: c.req.header("host"),
        forwardedHost: c.req.header("x-forwarded-host"),
      });
      const connection = ctx.projects.connection(c.req.param("id"), { reveal, requestHost });
      if (reveal) {
        audit(ctx.db.db, {
          actor: c.get("admin")!.email,
          action: "project.credentials_revealed",
          projectId: c.req.param("id"),
          ip: clientIp(c),
        });
      }
      return c.json({ connection });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.post("/:id/actions/:action", async (c) => {
    const action = c.req.param("action");
    if (!(PROJECT_ACTIONS as readonly string[]).includes(action)) {
      throw HttpError.badRequest(`Unknown action "${action}"`);
    }

    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const project = await ctx.projects.setRunning(
        c.req.param("id"),
        action as "start" | "stop" | "restart",
      );
      audit(ctx.db.db, {
        actor: admin.email,
        action: `project.${action}`,
        projectId: project.id,
        ip: clientIp(c),
      });
      return c.json({ project });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.delete("/:id", (c) => {
    const ctx = c.get("ctx");
    const admin = c.get("admin")!;
    try {
      const project = ctx.projects.delete(c.req.param("id"), admin.email);
      audit(ctx.db.db, {
        actor: admin.email,
        action: "project.delete",
        projectId: project.id,
        payload: { name: project.name, ref: project.ref },
        ip: clientIp(c),
      });
      return c.json({ project });
    } catch (err) {
      toHttpError(err);
    }
  });

  app.get("/:id/audit", (c) =>
    c.json({ entries: listAudit(c.get("ctx").db.db, { projectId: c.req.param("id"), limit: 100 }) }),
  );

  /**
   * Live metrics for one project.
   *
   * Read on demand rather than pushed, because a self-hosted control plane
   * should not be running a scrape loop against every database on the host to
   * populate a page nobody has open.
   */
  app.get("/:id/metrics", async (c) => {
    const ctx = c.get("ctx");
    try {
      const metrics = await ctx.metrics.snapshot(c.req.param("id"));
      return c.json({
        ...metrics,
        growthBytesPerDay: ctx.metrics.growthBytesPerDay(c.req.param("id")),
      });
    } catch (err) {
      toHttpError(err);
    }
  });

  return app;
}
