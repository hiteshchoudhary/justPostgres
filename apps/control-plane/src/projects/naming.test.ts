import assert from "node:assert/strict";
import { test } from "node:test";
import { pinnedHost, type Config } from "../config.js";
import { buildEndpoints, requestHostname } from "./naming.js";

test("the request's hostname is used, without the UI's port", () => {
  assert.equal(requestHostname({ host: "31.97.226.217:8080" }), "31.97.226.217");
  assert.equal(requestHostname({ host: "DB.Example.com" }), "db.example.com");
  assert.equal(requestHostname({ host: "[2001:db8::1]:8080" }), "[2001:db8::1]");
});

test("behind a proxy, X-Forwarded-Host wins over Host", () => {
  assert.equal(
    requestHostname({ host: "control-plane:3000", forwardedHost: "db.example.com, proxy.internal" }),
    "db.example.com",
  );
  assert.equal(requestHostname({ host: "db.example.com", forwardedHost: "" }), "db.example.com");
});

test("anything that is not a plain host is refused rather than put in a URL", () => {
  assert.equal(requestHostname({ host: "evil.com/x?y=" }), null);
  assert.equal(requestHostname({ host: "a@b.com" }), null);
  assert.equal(requestHostname({ host: "[::1" }), null);
  assert.equal(requestHostname({}), null);
});

test("localhost and empty count as unset; anything else pins the host", () => {
  assert.equal(pinnedHost(undefined), null);
  assert.equal(pinnedHost(""), null);
  assert.equal(pinnedHost("localhost"), null);
  assert.equal(pinnedHost("db.example.com"), "db.example.com");
});

function endpoints(publicHost: string | null, routerHost: string | null, requestHost: string | null) {
  const config = {
    publicHost,
    router: { enabled: true, host: routerHost, sessionPort: 5432, poolPort: 6543 },
  } as unknown as Config;
  return buildEndpoints({
    config, ref: "abc", role: "postgres", password: "pw", database: "postgres",
    containerPort: 55001, reveal: true, requestHost,
  }).map((e) => e.url);
}

test("unpinned, every connection string names the host the UI was opened on", () => {
  assert.deepEqual(endpoints(null, null, "31.97.226.217"), [
    "postgresql://postgres.abc:pw@31.97.226.217:5432/postgres",
    "postgresql://postgres.abc:pw@31.97.226.217:6543/postgres",
    "postgresql://postgres:pw@31.97.226.217:55001/postgres",
  ]);
});

test("a pinned host wins over the request, and localhost is the last resort", () => {
  assert.ok(endpoints("db.example.com", "db.example.com", "1.2.3.4").every((u) => u!.includes("@db.example.com:")));
  assert.ok(endpoints(null, null, null).every((u) => u!.includes("@localhost:")));
});
