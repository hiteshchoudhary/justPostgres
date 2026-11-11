import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HttpError } from "./errors.js";
import { isCrossSiteWrite, rejectCrossSiteWrites } from "./origin.js";

const h = (init: Record<string, string>) => new Headers(init);

test("the admin UI's own writes pass (Sec-Fetch-Site: same-origin)", () => {
  assert.equal(isCrossSiteWrite("POST", h({ "sec-fetch-site": "same-origin", host: "admin.example.com" })), false);
});

test("a write from a project's sibling subdomain is refused, though SameSite=Lax would send the cookie", () => {
  assert.equal(isCrossSiteWrite("POST", h({ "sec-fetch-site": "same-site", origin: "https://abc123.api.example.com" })), true);
  assert.equal(isCrossSiteWrite("DELETE", h({ "sec-fetch-site": "cross-site" })), true);
});

test("without Sec-Fetch-Site, Origin is compared to Host by host, ignoring scheme", () => {
  assert.equal(isCrossSiteWrite("POST", h({ origin: "https://admin.example.com", host: "admin.example.com" })), false);
  assert.equal(isCrossSiteWrite("POST", h({ origin: "https://evil.example", host: "admin.example.com" })), true);
  assert.equal(isCrossSiteWrite("POST", h({ origin: "null", host: "admin.example.com" })), true);
  assert.equal(
    isCrossSiteWrite("POST", h({ origin: "https://admin.example.com", host: "127.0.0.1:3000", "x-forwarded-host": "admin.example.com" })),
    false,
    "a proxy that rewrites Host but forwards the original is allowed",
  );
});

test("reads and non-browser clients are not affected", () => {
  assert.equal(isCrossSiteWrite("GET", h({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isCrossSiteWrite("POST", h({ host: "admin.example.com" })), false, "curl sends no Origin");
});

test("wired as middleware: refused with 403 before the handler runs", async () => {
  const app = new Hono();
  let ran = false;
  app.use("*", rejectCrossSiteWrites());
  app.post("/x", (c) => { ran = true; return c.text("ok"); });
  app.onError((err, c) => c.json({}, err instanceof HttpError ? (err.status as 403) : 500));

  const res = await app.request("/x", { method: "POST", headers: { "sec-fetch-site": "same-site" } });
  assert.equal(res.status, 403);
  assert.equal(ran, false);
});

test("an oversized body is refused with 413 before it is parsed", async () => {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: () => { throw new HttpError(413, "payload_too_large", "big"); } }));
  app.post("/login", async (c) => c.json(await c.req.json()));
  app.onError((err, c) => c.json({}, err instanceof HttpError ? (err.status as 413) : 500));

  const big = JSON.stringify({ email: "a".repeat(64 * 1024) });
  assert.equal((await app.request("/login", { method: "POST", body: big })).status, 413);
  assert.equal((await app.request("/login", { method: "POST", body: '{"email":"a"}' })).status, 200);
});
