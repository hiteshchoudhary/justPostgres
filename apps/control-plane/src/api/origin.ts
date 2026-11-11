import type { MiddlewareHandler } from "hono";
import { HttpError } from "./errors.js";

/**
 * Refuse state-changing API requests that a browser sent on another site's
 * behalf.
 *
 * The session cookie is `SameSite=Lax`, which stops a *cross-site* POST from
 * carrying it — but "site" is the registrable domain, so a page on a sibling
 * subdomain is same-site and gets the cookie. With the REST hostname form
 * enabled, every project serves pages on `<ref>.<suffix>`, which is exactly
 * such a sibling. And the API parses JSON whatever the Content-Type says, so a
 * plain HTML form or a `no-cors` fetch is enough to fire a request at it.
 *
 * Browsers say where a request came from in two headers no page can forge:
 * `Sec-Fetch-Site`, checked first because it survives any proxy that rewrites
 * `Host`, and `Origin` as the fallback for browsers that predate it. A request
 * with neither is not from a browser — curl, scripts — and carries no ambient
 * credential to abuse, so it is let through to the ordinary session check.
 */
export function rejectCrossSiteWrites(): MiddlewareHandler {
  return async (c, next) => {
    if (!isCrossSiteWrite(c.req.method, c.req.raw.headers)) return next();
    throw new HttpError(
      403,
      "cross_site_request",
      "This request came from another site and was refused.",
    );
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isCrossSiteWrite(method: string, headers: Headers): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite !== "same-origin" && fetchSite !== "none";

  const origin = headers.get("origin");
  if (!origin) return false;
  if (origin === "null") return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  // Compared by host, not scheme: TLS usually ends at a proxy in front, so the
  // browser's https origin reaches us as plain http with the Host preserved.
  const hosts = [headers.get("host"), headers.get("x-forwarded-host")?.split(",")[0]]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.trim().toLowerCase());
  return !hosts.includes(originHost);
}
