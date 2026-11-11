import assert from "node:assert/strict";
import { test } from "node:test";
import { filterRequestHeaders, filterResponseHeaders, PROXY_CSP } from "./proxy.js";

/**
 * The proxy serves a project's API from the same origin as the admin UI, so the
 * header boundary in both directions is a security boundary. These tests exist
 * because the outbound half of it was once missing.
 */

test("outbound: an upstream Set-Cookie is stripped (session cannot be overwritten)", () => {
  const upstream = new Headers({ "content-type": "application/json" });
  upstream.append("set-cookie", "jp_session=attacker-controlled; Path=/; HttpOnly");

  const out = filterResponseHeaders(upstream);

  assert.deepEqual(out.getSetCookie(), [], "no Set-Cookie may reach the admin origin");
});

test("outbound: multiple Set-Cookie headers are all stripped", () => {
  const upstream = new Headers();
  upstream.append("set-cookie", "a=1; Path=/");
  upstream.append("set-cookie", "jp_session=evil; Path=/");

  assert.deepEqual(filterResponseHeaders(upstream).getSetCookie(), []);
});

test("outbound: legitimate PostgREST headers survive", () => {
  const upstream = new Headers({
    "content-type": "application/json",
    "content-range": "0-9/100",
    // PostgREST returns Location on a 201-Created insert. Dropping it — as an
    // over-broad fix would — breaks resource creation, so it must be kept.
    location: "/todos?id=eq.42",
  });

  const out = filterResponseHeaders(upstream);

  assert.equal(out.get("content-type"), "application/json");
  assert.equal(out.get("content-range"), "0-9/100");
  assert.equal(out.get("location"), "/todos?id=eq.42");
});

test("inbound: the admin session cookie is not forwarded to a project", () => {
  const incoming = new Headers({
    cookie: "jp_session=real-admin-session",
    authorization: "Bearer project-jwt",
  });

  const out = filterRequestHeaders(incoming);

  assert.equal(out.get("cookie"), null, "the admin credential must not reach the project");
  assert.equal(out.get("authorization"), "Bearer project-jwt", "the project's own JWT passes through");
});

test("outbound: a project-chosen text/html response is sandboxed, not run on the admin origin", () => {
  // A database function can set Content-Type: text/html through PostgREST's
  // response.headers GUC (verified on PostgREST 16.2). Unsandboxed, that page
  // runs script with the admin's session.
  const upstream = new Headers({ "content-type": "text/html" });

  const out = filterResponseHeaders(upstream);

  const csp = out.get("content-security-policy") ?? "";
  assert.match(csp, /(^|;\s*)sandbox(;|$)/, "the document must get an opaque origin");
  assert.match(csp, /default-src 'none'/, "no script, style or subresource may load");
  assert.equal(out.get("x-content-type-options"), "nosniff");
});

test("outbound: a project's own CSP is replaced, so it cannot loosen the sandbox", () => {
  const upstream = new Headers({
    "content-type": "text/html",
    "content-security-policy": "default-src * 'unsafe-inline'",
    "content-security-policy-report-only": "default-src *",
  });

  const out = filterResponseHeaders(upstream);

  assert.equal(out.get("content-security-policy"), PROXY_CSP);
  assert.equal(out.get("content-security-policy-report-only"), null);
});

test("outbound: headers that act on the whole admin origin are dropped", () => {
  const upstream = new Headers({
    "clear-site-data": '"cookies", "storage"',
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    refresh: "0; url=https://evil.example",
    "service-worker-allowed": "/",
  });

  const out = filterResponseHeaders(upstream);

  for (const name of ["clear-site-data", "strict-transport-security", "refresh", "service-worker-allowed"]) {
    assert.equal(out.get(name), null, `${name} must not reach the admin origin`);
  }
});
