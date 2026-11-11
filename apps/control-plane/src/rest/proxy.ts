import { Hono, type Context } from "hono";
import type { HonoEnv } from "../api/context.js";

/**
 * The public face of a project's REST API.
 *
 * PostgREST is published on the host's loopback interface only, so this proxy
 * is the only route in from anywhere else. That is worth the hop: the API
 * cannot be found by scanning the machine from the network, it can be turned
 * off centrally by flipping one row, and adding TLS or rate limiting later is a
 * change in one place rather than per project.
 *
 * Two addressing forms, the same fallback shape as the database router:
 *
 *   /rest/<project-ref>/<table>        always works
 *   <project-ref>.api.example.com/     needs wildcard DNS, nicer to use
 *
 * The proxy deliberately does **not** interpret the Authorization header. The
 * JWT is PostgREST's business, and revalidating it here would mean two
 * implementations of the same check that could disagree — the worse kind of
 * security bug, because it looks correct from both sides.
 */
/**
 * Headers that go *to* a project's API.
 *
 * Hop-by-hop headers must not be forwarded, and Host must reflect the upstream
 * or PostgREST builds wrong URLs in its OpenAPI output. The control plane's own
 * session cookie is stripped too: forwarding it would leak an admin credential
 * to a service the project's own users can reach.
 */
export function filterRequestHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("transfer-encoding");
  headers.delete("upgrade");
  headers.delete("cookie");
  return headers;
}

/**
 * Headers that come *back* from a project's API.
 *
 * The critical one is `set-cookie`. The proxy serves /rest/<ref>/ from the same
 * origin as the admin UI and /api, and the admin session cookie is Path=/ — so
 * an upstream Set-Cookie, which a project can emit at will (PostgREST exposes
 * the `response.headers` GUC to database functions), would land in the admin's
 * cookie jar and overwrite the session. Stripping it is the outbound mirror of
 * the inbound `cookie` strip; the two belong together, and the absence of this
 * half was a reported vulnerability.
 *
 * `location` is deliberately kept: PostgREST returns it on 201-Created inserts,
 * and dropping it would break resource creation for a threat it does not carry.
 *
 * The body is the other half. A database function can set its own
 * `Content-Type` through the same GUC, so a project can answer with
 * `text/html` — verified against PostgREST 16.2 — and that page would run
 * script on the admin origin with the admin's session: one call to the API
 * then reveals every project's credentials. Every proxied response is
 * therefore a sandboxed document (`CSP: sandbox` gives it an opaque origin and
 * no script), and `nosniff` stops a browser guessing its way to HTML. CSP does
 * nothing to a `fetch()` of JSON, so API clients are unaffected.
 *
 * Headers that act on the whole origin rather than on this one response are
 * dropped: `Clear-Site-Data` would sign the admin out, HSTS would pin a
 * policy the operator never chose, and `Refresh` is a redirect by another name.
 * Any CSP the project sends is replaced, not merged, so it cannot loosen ours.
 */
export const PROXY_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

const ORIGIN_WIDE_HEADERS = [
  "set-cookie",
  "clear-site-data",
  "strict-transport-security",
  "refresh",
  "content-security-policy",
  "content-security-policy-report-only",
  "service-worker-allowed",
];

export function filterResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete("transfer-encoding");
  headers.delete("connection");
  for (const name of ORIGIN_WIDE_HEADERS) headers.delete(name);
  headers.set("content-security-policy", PROXY_CSP);
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

export function restProxyRoutes() {
  const app = new Hono<HonoEnv>();

  // The remainder of the path is taken from the URL rather than from a route
  // parameter: Hono does not expose the `*` segment as a named param, and
  // reading it as one silently yields an empty string — which forwards every
  // request to `/` and makes the whole API answer with its own OpenAPI
  // document, whatever was asked for.
  app.all("/:ref", (c) => forward(c, c.req.param("ref"), "/"));
  app.all("/:ref/*", (c) => {
    const ref = c.req.param("ref");
    const pathname = new URL(c.req.url).pathname;
    const prefix = `/rest/${ref}`;
    const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "/";
    return forward(c, ref, rest || "/");
  });

  return app;
}

/** Hostname form: `<ref>.<suffix>` resolved from the Host header. */
export function refFromHost(host: string | undefined, suffix: string | null): string | null {
  if (!host || !suffix) return null;
  const name = host.split(":")[0]!.toLowerCase();
  const dotted = `.${suffix.replace(/^\./, "").toLowerCase()}`;
  if (!name.endsWith(dotted)) return null;
  const ref = name.slice(0, -dotted.length);
  return ref.length > 0 && !ref.includes(".") ? ref : null;
}

async function forward(c: Context<HonoEnv>, ref: string, path: string): Promise<Response> {
  const ctx = c.get("ctx");
  const target = await ctx.rest.targetFor(ref);

  if (!target) {
    // The same answer whether the project does not exist or its API is off.
    // Distinguishing them would turn this endpoint into a way to enumerate
    // which projects exist on a host.
    return c.json(
      { message: "No API is enabled at this address.", code: "api_not_enabled" },
      404,
    );
  }

  const url = new URL(c.req.url);
  const upstream = `http://${target.host}:${target.port}${path}${url.search}`;

  const headers = filterRequestHeaders(c.req.raw.headers);

  try {
    const response = await fetch(upstream, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      // Required by undici whenever a request has a streaming body.
      ...(c.req.method === "GET" || c.req.method === "HEAD" ? {} : { duplex: "half" }),
      redirect: "manual",
    } as RequestInit);

    const outHeaders = filterResponseHeaders(response.headers);

    return new Response(response.body, { status: response.status, headers: outHeaders });
  } catch (err) {
    ctx.logger.warn({ err, ref }, "could not reach a project's REST container");
    return c.json(
      { message: "The API for this project is not reachable right now.", code: "api_unreachable" },
      502,
    );
  }
}
