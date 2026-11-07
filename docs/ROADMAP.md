# Roadmap to 1.0

[D4](ARCHITECTURE.md#1-decision-log) commits to shipping the full scope at 1.0 rather than a thin
slice: provisioning, table view, PITR, branching, pooling, extensions and the REST API all land
together. This document sequences that work and names what could go wrong.

Sizes are relative (S ≈ days, M ≈ 1–2 weeks, L ≈ 3–4 weeks, XL ≈ 6+ weeks) for one focused
developer. They are estimates for ordering, not commitments to dates.

---

## Sequencing principle: risk before polish

The order below is not "easiest first" and it is not the order a user experiences the product.
It is dependency order with one override — **the router (M2) comes far earlier than its user-facing
value justifies**, because it is the piece most likely to fail, and a failure discovered in month one
costs a fallback to per-project ports, while the same failure discovered in month five costs the
release. Everything after M2 assumes it works; nothing after M2 makes it easier to find out.

The second override is that **backups (M4) come before branching (M5), extensions (M6) and the API
(M7)**, even though branching is the more exciting demo. Branching is a re-skin of the restore path.
Building the exciting thing first would mean building the restore engine anyway, but with the
incentive to cut corners on the correctness of the part people's data actually depends on.

---

## M0 — Foundations · S  ✅ complete

The skeleton everything else is committed into.

- Monorepo: `apps/control-plane`, `apps/router`, `packages/shared`, `images/postgres`
- Hono API server, React + Vite UI, single Docker image
- SQLite metadata store behind Drizzle, migrations
- Job runner: `jobs` table, lease-based claim, heartbeat, retry, resumability
- Docker driver behind an interface, talking to a socket proxy
- Structured logging, config via env, `docker compose up` gets you a running (empty) control plane

**Exit:** `docker compose up` serves a UI that lists zero projects and a job runner that executes a
no-op job and survives a restart mid-run.

**Verified.** The exit criterion was demonstrated end to end:

- A 30-step job was killed with `SIGKILL` at step 7. On restart the control plane reported one
  orphaned job, reclaimed it once the lease expired, and resumed at step 8 — finishing with
  `Completed 30 steps (resumed after step 7)` on attempt 2. It did not start over.
- `SIGTERM` releases the lease, refunds the attempt, and preserves the checkpoint, so a planned
  restart costs a job nothing.
- Retry with backoff, cooperative cancellation mid-run, and permanent failure on a malformed
  payload (attempt 1, no retries) all behave as specified.
- With the Docker daemon stopped, the control plane still boots, serves the UI, and reports
  `docker: down` on the health page — the property ARCHITECTURE §3 argues for.

**Docker image and compose: verified** (after M1, once a daemon was available). Two bugs had to be
fixed first:

1. The runtime stage flattened the workspace layout and relied on `NODE_PATH` to find dependencies.
   **`NODE_PATH` does nothing for ESM** — Node's ESM resolver ignores it — and pnpm's `node_modules`
   is a tree of relative symlinks into the root store, so moving either half breaks every link. The
   runtime image now mirrors the workspace layout exactly.
2. `JP_PORT` meant two different things in `docker-compose.yml`: the container's listen port and the
   published host port. The host side is now `JP_HTTP_PORT`.

With those fixed: `docker compose up` brings up the control plane and socket proxy, the control plane
reaches Docker through the proxy, and a project created through the stack provisions as a sibling
container, publishes its host port, and accepts a `psql` connection with `CREATE EXTENSION vector`
working.

## M1 — Provisioning · M  ✅ complete

The first thing that is recognisably the product.

- Create project: pull image, create volume, generate credentials, start container, health-check
- Start / stop / restart / delete, with volume lifecycle and a delete confirmation
- Postgres major version selection at creation, pinned thereafter
- Per-project resource limits, network isolation, container hardening from
  [ARCHITECTURE §4](ARCHITECTURE.md#4-data-plane-the-project-container)
- Credential encryption with `JP_MASTER_KEY`
- Reconciler loop: diff metadata against Docker, repair drift, reap orphans
- Connection string surfaced in the UI (per-project port mode only, for now)
- Control-plane admin auth: single administrator, scrypt, cookie sessions, per-address lockout — resolves [open question 1](ARCHITECTURE.md#12-open-questions)

**Exit:** create a project in the UI, connect with `psql` using the string it gives you, `CREATE
EXTENSION vector`, restart the control plane, and find everything still correct.

**Verified.** The whole exit criterion, plus the surrounding behaviour:

- Project created from the UI reached `running` in ~2s on a warm image. Connecting from outside the
  host with the generated URL: `PostgreSQL 17.11`, `rolsuper = t`, `CREATE EXTENSION vector` →
  `vector 0.8.6`, and a nearest-neighbour query returning the right row.
- Control plane restarted mid-life: session survived, project still `running`, container still
  `running`, inserted rows still there.
- Container hardening confirmed on the running container: `Memory=536870912`, `NanoCpus=1000000000`,
  `ShmSize=268435456`, `CapDrop=[ALL]`, `SecurityOpt=[no-new-privileges]`, `Privileged=false`.
- Reconciler: a container stopped behind the control plane's back was detected and the project
  corrected to `stopped` within one pass; started again behind its back, corrected back to `running`.
  An orphaned volume was reported and deliberately **not** deleted.
- Delete removed container, volume and network, released the host port back to the pool, and left the
  row soft-deleted with its audit trail intact.
- Auth: first-run setup, weak-password rejection, session cookie `HttpOnly`, `setup` refusing to run
  twice, logout invalidating the session, per-address lockout after 5 failures (one address locked
  out while another signed in normally), and equal response time for a known vs unknown email.
- `pg_cron` correctly refuses to install without `shared_preload_libraries`, which is the M6 case the
  design already calls out.

**Measured:** ~23 MiB idle RAM per project (21.8 / 22.3 / 24.4 MiB across three), control plane
73 MiB. Well under the 50–100 MB the design assumed — [open question 2](ARCHITECTURE.md#12-open-questions)
is answered, and the honest caveat is in the README.

**Two bugs found and fixed during M1:**

1. Provisioning pulled the image unconditionally, which fails with "pull access denied" for locally
   built images that are published nowhere. Now local-first: pull only what is missing.
2. The login lockout bucketed by a client IP that was `null` for direct connections, so every client
   shared one bucket — meaning one attacker could lock out the real administrator and the throttle
   was not per-attacker at all. Now falls back to the socket address.

**Docker deployment verified** after this milestone — see the note under M0 for the two bugs that
had to be fixed to get there.

## M2 — Router and pooler · L  ✅ complete  (was the highest-risk milestone)

Built early on purpose. See the sequencing principle above.

- Postgres wire-protocol front end: `SSLRequest` preamble, startup packet parsing
- Routing mode 1: SNI → project, with wildcard TLS
- Routing mode 2: `<role>.<project_ref>` username prefix, validated against metadata, never trusted
- Routing mode 3: per-project ports, retained as the permanent fallback
- Session-mode passthrough on 5432
- Transaction-mode pooling on 6543: `ReadyForQuery` status tracking, server-connection reuse,
  pool sizing per project
- Hot reload of routes as projects are created and deleted
- **Benchmark gate:** throughput and p99 latency against PgBouncer, with the rewrite-in-Go threshold
  agreed *before* the numbers come in — [open question 3](ARCHITECTURE.md#12-open-questions)

  **The threshold, written down before measuring:**

  | Metric | Pass | Acceptable, with a note | Schedule the rewrite |
  |---|---|---|---|
  | Select-only TPS, as a fraction of PgBouncer | ≥ 50% | 25–50% | < 25% |
  | p99 latency added over a direct connection | < 2 ms | 2–5 ms | > 5 ms |

  The reasoning: PgBouncer is single-threaded C and will win outright; the question is not whether
  the router is slower but whether it is slow enough to be felt. On a single-VPS deployment serving
  one team, half of PgBouncer's throughput is an enormous amount of headroom, and 2 ms is under the
  noise floor of any real query. Falling below a quarter of PgBouncer, or adding more than 5 ms,
  means the pooler has become the bottleneck rather than the thing that removes one — and the design
  already anticipates that outcome by keeping the router a separate process.

**Exit:** both connection strings work against several projects through one port; the benchmark either
passes the agreed bar or the router is scheduled for a rewrite in a compiled language while the
product continues on mode 3.

### Verified

- **Session mode** routes on SNI and on the username prefix, on the same listener. SCRAM is relayed,
  not intercepted — the router never sees the password on this path — and rewriting the startup
  username works because Postgres resolves the role from the startup packet while SCRAM's proof is
  computed over the SASL exchange.
- **TLS termination with SNI**: connecting to `<ref>.db.local` with a plain `postgres` username
  routed correctly on hostname alone.
- **Transaction pooling** with the router's own SCRAM-SHA-256 implementation on both sides:
  authenticating the client as a server, and authenticating to Postgres as a client (including
  verifying the server signature). A wrong password is rejected with `28P01`.
- **Transaction integrity**: a `BEGIN`…`ROLLBACK` block stayed pinned to one backend (same
  `pg_backend_pid()` throughout) and the rollback took effect. 20 concurrent clients were served by a
  pool capped at 5, and 8 sequential connections reused a single server connection.
- **Query cancellation** works in both modes — `Ctrl-C` produced `canceling statement due to user
  request`, with zero unmatched cancel keys. This needs the router to track `BackendKeyData` as it
  passes through, because a `CancelRequest` arrives on a new connection carrying numbers the proxy
  would otherwise know nothing about.
- **Errors are Postgres errors**: an unknown project ref produces `FATAL: Could not determine which
  project ... refers to` with a hint, not a dropped socket.
- Extended protocol, 200k-row results, and multi-segment payloads all behave.

### The benchmark gate

Every pooler in a container on the same network path, `pgbench -S`, 10 clients, macOS/Docker Desktop.
Absolute numbers are inflated by that VM network stack; the ratios are the point.

| Workload | direct | PgBouncer | jp session | jp pooled | pooled vs PgBouncer |
|---|---|---|---|---|---|
| select-only, simple protocol | 16167 | 8596 | 6782 | 4646 | **54%** |
| …repeat 1 | — | 8671 | 6920 | 4912 | 57% |
| …repeat 2 | — | 7438 | 7268 | 4829 | 65% |
| select-only, extended protocol | 10703 | 8569 | 5757 | 3222 | **38%** |
| connection churn (`-C`) | 223 | 247 | 163 | 192 | 78% |
| p99 latency, simple | 1.30 ms | 1.77 ms | 2.06 ms | 3.02 ms | **+1.72 ms over direct** |

**Verdict against the threshold written down beforehand: pass, with one number to watch.**

- Simple-protocol throughput at 54–65% of PgBouncer clears the ≥50% pass band.
- p99 adds 1.72 ms over a direct connection, inside the < 2 ms pass band.
- **Extended protocol lands at 38%, in the "acceptable, with a note" band rather than the pass band.**
  That is the honest weak spot and it is the expected one: extended protocol sends five messages per
  transaction where simple sends one, so the router's per-message framing cost — the part written in
  JavaScript — is paid five times as often. Extended protocol is what real drivers use, so this is
  the number that would justify a Go rewrite first if anything does.

No rewrite is triggered: nothing fell below 25%, and the router remains a separate process and image
precisely so that decision stays cheap to make later. Retest extended protocol under M8's load work
before making any throughput claim publicly.

## M3 — Table view and SQL editor · M  ✅ complete

The daily-use surface.

- Schema tree: databases, schemas, tables, views, columns, indexes, foreign keys
- Table browser: keyset pagination, filters, sort, inline edit, insert, delete
- SQL editor: CodeMirror 6, schema-aware completion, results grid, multi-statement, CSV export
- `EXPLAIN` / `EXPLAIN ANALYZE` rendering
- Guardrails: statement timeout, result row cap, confirmation on unqualified `UPDATE`/`DELETE`

**Exit:** a full day of ordinary development without opening a desktop SQL client.

### Verified

Against a seeded database — 500 authors, **2,000,000 posts**, a view, and a deliberately
primary-key-less table:

- **Schema tree** reads tables, views, columns, types, nullability, defaults, identity columns,
  indexes, foreign keys and comments in one pass.
- **Keyset pagination pays off exactly as the design claimed.** At row 1,900,000:
  `OFFSET 1900000` → **230 ms**; the keyset equivalent → **0.04 ms**. The API round trip for that
  page was 56 ms end to end.
- **Honest fallbacks.** Sorting by a nullable column, or browsing a table with no primary key, falls
  back to OFFSET and says so in the UI rather than pretending to be fast.
- **Filters** across `=`, `>`, `ILIKE`, `IS NULL` and `IN`, with exact counts when filtered and a
  planner estimate when not — never an estimate of a filtered view, which would be a wrong number.
- **Editing** is refused where a row cannot be addressed unambiguously: views, foreign tables, and
  any table without a primary key. No `ctid` addressing, which silently targets the wrong row after
  a concurrent update.
- **The SQL splitter handles real SQL**: a `$$ … ; … $$` function body is one statement, a
  commented-out `WHERE` still counts as absent, and `select 'delete from posts'` is not flagged.
- **Guardrails**: `DELETE`/`UPDATE` without `WHERE`, `TRUNCATE` and `DROP` all require confirmation;
  statement timeouts are enforced (`canceling statement due to statement timeout`); a failing
  statement returns the results of the ones that already succeeded plus the statement that failed.
- **`EXPLAIN ANALYZE` on a `DELETE` rolls back** — row count was 5000 before and after. ANALYZE
  really executes the statement, so this had to be wrapped in a transaction that always aborts.

### Bugs found and fixed

1. **Returning every value as text broke introspection.** The data pool asks Postgres for the text it
   would render, so a boolean arrives as the string `"f"` — which is truthy in JavaScript. Every
   column came back marked as a primary key, and the primary-key-less table was reported as
   editable. Booleans and arrays out of the catalog queries are now coerced explicitly.
2. **`reltuples` is -1 on a never-analysed relation**, and the query clamped it to 0, so a freshly
   loaded table read "0 rows". Unknown and zero are now different values, and the UI shows `—`.
3. The row-count query sliced parameters by *filter count*, which is wrong the moment one `IN`
   filter contributes several. Filter clauses and their parameters are now tracked separately from
   the keyset cursor's.
4. `formatBytes` rounded everything to MB, so every small table displayed "0 MB".

## M4 — Backups and PITR · L  ✅ complete

The feature the project is actually for.

- pgBackRest baked into the project images; `archive_command` wired at provisioning
- Repository configuration: S3-compatible or local — resolves
  [open question 4](ARCHITECTURE.md#12-open-questions)
- Scheduled full / incremental backups via the job runner, retention and expiry
- Recovery-window computation and display: "restorable from X to Y"
- **Restore into a new project** as the default path, non-destructive by construction
- **Promote**: swap routing so the restored project answers on the original hostname
- In-place restore behind an explicit confirmation
- Archiving-failure alerting — a project silently not archiving looks healthy until it matters
- Restore-verification job: periodically restore a backup and confirm it starts

**Exit:** kill a project's data, restore to a timestamp 20 minutes before the damage, promote it, and
have the application reconnect without a config change. Then do it again from a cold host where the
only surviving artifact is the S3 bucket.

### Verified — both halves

**The disaster and the recovery.** 1000 orders, a full backup, 500 more orders (existing only in the
WAL stream), a recorded safe point, then `delete from orders where id > 200` leaving 200 rows.
Restoring to the safe point produced a **new** project holding 1500 rows while production kept
serving its damaged 200 — untouched throughout. The restored copy was out of recovery and writable.
Promote then swapped the two projects' `ref` and published port, and **the same unchanged connection
string went from seeing 200 rows to seeing 1500**.

**The cold host.** A project's container and data volume were destroyed outright, leaving only its
backup volume. Restoring from that volume alone rebuilt a working database in 12 seconds. (Run
against a posix repository rather than S3 — the S3 code path is written and configurable but has not
been exercised, which is recorded below as a known gap.)

**Restore verification.** Restores the latest backup into a throwaway volume, starts Postgres with no
published port and archiving off, waits for recovery to finish, and asks it a real question:
`69 tables, recovered to 0/A000000`. It removes its container and volume afterwards — verified as
zero left behind.

**Archiving-failure alerting.** With both `archive.info` and its `.copy` removed, the failure was
detected within **6 seconds** and the project marked `archivingHealthy: false`, with the recovery
window refusing to claim anything restorable.

### Five bugs found and fixed, three of them serious

1. **`archive-push` writes to *every* configured repository.** Configuring the source project's repo
   as repo2 so `restore_command` could replay its WAL also made the restored cluster try to archive
   its own WAL *into the source project's repository*, under a stanza that does not exist there.
   Archiving broke permanently and the first backup timed out waiting for a segment that could never
   arrive. The source repository now appears only on the `restore_command` line, never in the
   container environment.

2. **The reconciler masked a failed restore.** When the restore job exhausted its attempts and set
   the project to `failed`, the next reconcile pass saw a running container and "corrected" it back
   to `running` — presenting a broken restore as a healthy project. For a backup tool that is the
   worst possible way to be wrong. `failed` is now never cleared by the reconciler; only an explicit
   action or a successful job clears it.

3. **`--target-action` is rejected without an explicit `--type`.** Restoring to *latest* — what you
   do after losing a database outright — failed every time. Only PITR-to-a-timestamp worked, which
   is precisely the case a casual test would cover and the real emergency would not.

4. **Promote deadlocked on its own port swap**, recreating the promoted container while the demoted
   one still held the port. Both are now released before either is recreated.

5. **`pg_is_in_recovery()::text` prints `false`, not `f`.** The verification loop compared against
   `f`, never matched, and would have waited six hours instead of failing. Fixed, and the startup
   phase now has its own ten-minute budget separate from the restore's.

Plus two smaller ones: a restored project kept `awaitingFirstBackup` after taking a full backup,
which would have blocked restoring *from* it; and failures surfaced pgBackRest's entire verbose log
starting with "backup command begin" rather than the ERROR line, which matters because this is an
alert-level condition.

### Open question 4, answered

**One repository per project, not a shared repository with a stanza each.** The idiomatic pgBackRest
layout is the latter and its per-stanza retention would have worked — but `archive_command` runs as a
subprocess of Postgres, so the repository has to be reachable *from inside the project's container*,
where the user holds superuser and can run arbitrary code. A shared repository mount is a
cross-project read of everyone else's backups. Isolation beats idiom.

### Known gaps

- ~~**S3 is written but untested.**~~ **Tested in M8** against MinIO, including a full restore from
  the bucket, and configurable from the UI. The original note follows.

  The configuration path exists and is documented; nothing has run
  against a real bucket. It also carries a caveat that posix does not: credentials that reach a
  container reach the whole bucket unless the operator scopes them per prefix. pgBackRest's TLS
  server mode is the proper multi-tenant answer and is not built.
- **In-place restore** is not implemented. Restore always produces a new project, which is the
  designed default; the destructive variant behind a confirmation is still to do.
- Retention is exercised only in the sense that `expire` runs after every backup; no test has yet
  aged a repository past its retention window.

## M5 — Branching · M  ✅ complete

Mostly UX over M4's engine, plus one genuinely new piece.

- `POST /projects/:id/branches`, from latest or from a timestamp
- Parent / branch-point tracking and a branch view in the UI
- Branch lifecycle: TTL and auto-expiry, so throwaway branches actually get thrown away
- **CoW fast path**: detect ZFS or btrfs `PGDATA` at install time, use snapshot + clone for
  near-instant branching, falling back to PITR restore everywhere else

**Exit:** branch a non-trivial project, run a destructive migration on the branch, confirm the parent
is untouched, delete the branch. On a ZFS host, the branch is near-instant.

### Verified

Against a 400,000-row, 127 MB database, on a real btrfs filesystem:

| | Time |
|---|---|
| **Copy-on-write branch** (from now) | **6.3 s** |
| Point-in-time branch (from the past) | 16 s, after the fallback fix — and it must restore and replay |
| Full backup of the same database | 6.3 s |

The snapshot itself is ~150 ms; the rest of the 6.3 s is starting the privileged helper container and
Postgres. That distinction matters for the claim: the branch cost is dominated by container startup,
not by database size.

- **Storage really is shared.** Two subvolumes each reporting 342 MB apparent size, with the
  filesystem using 370 MB in total — copy-on-write, not a copy.
- **The exit criterion:** the branch had the parent's 400,000 rows; a destructive migration on it
  (`drop column`, delete half the rows, `add column`, `create table`) left the parent at 400,000 rows
  with its original columns and no new table.
- **Deleting a branch removes its subvolume**, not just the Docker volume pointing at it.
- **Branch expiry works**: an expired branch was deleted by the sweep, container, volume, subvolume
  and all.
- **The UI explains its own strategy** before you commit: choosing "from right now" shows
  copy-on-write, switching to "from a point in time" switches to point-in-time restore and says why.

**ZFS is written but untested.** The btrfs path is exercised end to end; the ZFS commands
(`zfs snapshot` + `zfs clone`) are implemented against the same interface but no ZFS host was
available. Treat that path as unproven.

### Three bugs found and fixed

1. **A recovery target past the end of the WAL hung the job forever.** Restoring an idle database to
   "a few minutes ago" is a completely ordinary request, and Postgres treats it as a hard failure —
   `recovery ended before configured recovery target was reached` — then Docker's restart policy
   restarts the container, which crash-loops. The promotion loop kept polling for six hours. Now the
   condition is detected and the restore is redone without a target, because "restore to a time after
   everything" is what the user meant by "restore everything"; the result says so rather than
   pretending the target was honoured.

2. **Crash detection cannot poll container state.** The first attempt at (1) checked whether the
   container was running — but a crash-looping container reports *running* almost all of the time,
   so the check almost never fired. Reading the container's logs is what actually distinguishes
   "still starting" from "will never start".

3. **The restore path bypassed the data store**, creating a plain Docker volume on a copy-on-write
   host. A project created by restoring could therefore never be branched with a snapshot — a
   project whose capabilities silently depended on how it happened to be created. Both provisioning
   and restore now go through the same store.

### The design point worth keeping

The two strategies are not a fast path and a slow path for the same operation; they answer different
questions. A snapshot captures *now* and cannot travel backwards. Replaying WAL can reach any moment
in the recovery window and cannot avoid the cost of doing so. The service picks by what was asked
for, not by configuration, and tells the user which it chose and why.

## M6 — Extensions · S  ✅ complete

- Curated set baked into images: `pgvector`, `postgis`, `pg_cron`, `pg_stat_statements`, `hstore`,
  `uuid-ossp`, `pgcrypto`, `timescaledb` (Apache build only)
- One-click enable via `CREATE EXTENSION`
- **Preload handling**: extensions needing `shared_preload_libraries` edit `postgresql.conf` and
  restart the container — presented in the UI as a job with downtime, warned about before the click
- Version display and upgrade path

**Exit:** enable `pgvector` instantly; enable `pg_cron` and get an honest "this restarts your database"
dialog followed by a working `pg_cron`.

### Verified

| | |
|---|---|
| pgvector enable | **0.06 s**, then `'[1,2,3]'::vector <-> '[3,1,2]'` returns 2.449 |
| PostGIS enable | **0.30 s**, then `st_centroid` returns `POINT(5 5)` |
| pg_cron enable | **3.1 s** including the restart, then `cron.schedule` works |

- The API returns **202, not 200**, for a restart-requiring enable: the extension is not usable yet,
  and a 200 would invite the UI to claim otherwise.
- After the restart, `shared_preload_libraries = pg_cron` and `cron.database_name = postgres`, and a
  scheduled job appears in `cron.job`.
- 61 extensions are available from the image; the curated ones carry descriptions and links, and the
  rest are listed plainly rather than hidden.

### Two decisions revised

**PostGIS is now in the image.** It was excluded in M1 on size grounds, and that reasoning was wrong:
the image is pulled once per *host* and shared by every project on it, so the cost is paid once
rather than per project. The measured increase was 651 MB → 905 MB — 254 MB, not the tripling
assumed. A geospatial database that cannot do geospatial work without rebuilding its image was the
worse trade.

**TimescaleDB is still out.** It needs a third-party apt repository and only its Apache-licensed
subset is redistributable here — enough moving parts to deserve a deliberate follow-up rather than
being bundled in quietly.

### The refactor this milestone forced

Four places were building a project's container spec by hand — provisioning, restore, branch and
promote. Every new setting had to be added to all four, and one that reached only three produced a
project that behaved differently depending on how it happened to be created. That failure mode had
already cost a real bug in M5 (a restored project silently missing its copy-on-write data directory).
`shared_preload_libraries` would have been the second. The assembly now lives in one function, which
deleted enough duplication that the cleanup removed dead imports from five files.

### The bug that refactor exposed

**A branch did not inherit its parent's `shared_preload_libraries`.** A copy of a database that had
`pg_cron` enabled still contains `pg_cron` in its catalog — so without the library preloaded, every
one of its functions fails. The copy would have looked identical and been subtly, silently broken.
Branches and restores now inherit the setting, verified by branching a project with `pg_cron` and
confirming the branch came up with the library loaded and `cron.job` readable.

## M7 — REST API and RLS · L  ✅ complete

The largest single milestone and the one that most changes what the project is.

- Per-project PostgREST, lazily started, only when the API is enabled
- HTTP routing by hostname through Caddy → control-plane proxy → project PostgREST
- Per-project JWT secret; anon and service_role key issuance and rotation
- Documented BYO-identity path for Clerk / Auth0 / WorkOS / Better Auth signing with the project secret
- **RLS policy editor**: per-table policy list, guided builders for owner-only, tenant-isolation and
  public-read, raw SQL escape hatch
- **The unmissable warning**: any table exposed through the API with RLS disabled gets a loud banner.
  This is the most common way people publish their entire database to the internet.
- Auto-generated API docs per project

**Exit:** enable the API on a project, hit it with the anon key, watch RLS correctly deny what it
should, and sign a JWT from an external identity provider that flows into policy decisions unchanged.

### Verified

Tokens for the identity test were minted **outside justpostgres entirely** — a standalone script
signing `{sub, role, iss: "https://example-idp.com"}` with the project's secret, exactly as Clerk,
Auth0 or WorkOS would:

- **Safe before anything is exposed.** A valid anon key against an unexposed table:
  `permission denied for table notes`. The service key sees everything, as it must.
- **Per-user isolation from an external token.** Alice's token returns only Alice's rows; Bob's
  returns only Bob's.
- **Writes are constrained too.** Alice posting a row with `owner_id: "bob"` is refused —
  `new row violates row-level security policy` — while her own row inserts fine. Her `DELETE` against
  Bob's row returns 204 and deletes nothing, which is what RLS is supposed to do.
- **A token signed with the wrong secret is rejected** (`PGRST301`).
- **The dangerous state is detected.** A manual `GRANT SELECT ... TO anon` with no RLS is flagged
  `exposedWithoutRls` and surfaced as a red banner; enabling RLS from the UI clears it.

### The decision that differs from Supabase, deliberately

**`anon` is granted nothing when the API is enabled.** In Supabase, `anon` gets blanket DML on
`public` and row-level security is the only thing between the internet and every table — which is
precisely why forgetting RLS on one table is such a well-known way to publish a database by accident.

Here, `expose` grants privileges, enables RLS and creates the policy **in one transaction**. Either a
table becomes reachable *with* a rule deciding who sees what, or nothing changes. The dangerous state
is not reachable by forgetting a step; it can only be created deliberately, which is why the warning
banner is a backstop rather than the primary defence.

### Three bugs found and fixed

1. **The proxy could not reach PostgREST at all.** The design said "publishes no ports, the proxy is
   the only way in" — which does not survive contact with the deployment model, because the control
   plane may be on the host rather than on the project's Docker network. PostgREST now publishes on
   the host's **loopback interface only**: reachable by the proxy, invisible to the network. The
   comments claiming otherwise were corrected rather than left to mislead.

2. **The proxy silently dropped the path.** Hono does not expose the `*` segment as a named
   parameter, so `c.req.param("*")` returned an empty string and *every* request was forwarded to
   `/` — meaning the API answered with its own OpenAPI document no matter what was asked for. A
   convincing-looking response that is entirely wrong.

3. **PostgREST could not see tables created after it started.** Its schema cache is built at startup,
   so a migration run in the SQL editor produced "could not find the table in the schema cache" for a
   table that plainly existed. Since this product ships a SQL editor next to the API, that is not an
   edge case — it is what happens the first time anyone runs a migration. DDL and every security
   change now trigger a cache reload; verified by creating a table and querying it through the API
   seconds later with no restart.

### The scope line held

No user management, no password reset, no OAuth providers. justpostgres issues two keys and installs
`auth.uid()`, `auth.role()` and `auth.claim()`; identity comes from whatever provider signs with the
project's secret. That is roughly 40 lines of JWT code instead of a service, and it is the difference
between this being a Postgres host with an API and being a worse Supabase.

## Between M7 and M8 — claiming the install

Found while walking through what a stranger meets on a fresh VPS: `POST /api/auth/setup` was
unauthenticated. There was no default password to leak, which is the usual mistake, but the first
request to reach an unclaimed install created the admin account — so on a public IP the owner is
whoever finds the page first, not whoever paid for the server. Reproduced by claiming a running
instance as `attacker@example.com` and getting a 201.

Fixed with the pattern Jenkins uses for `initialAdminPassword`: the first boot mints a
`jp_setup_…` token, stores it in a new `settings` table, and prints it on **every** boot while the
install is unclaimed — printing it once means it scrolls out of a log the operator reads an hour
later. `/setup` compares the presented token in constant time, and deletes it in the same
transaction that creates the admin. `JP_SETUP_TOKEN` lets a configuration manager pin the value.

Verified end to end: no token → 400, wrong token → 403 and an audit entry, correct token → 201,
replay → 409, and the `settings` row gone afterwards. Then claimed a fresh instance through the UI
to confirm the browser path, not just the API.

## M8 — Hardening and 1.0 · M

### Storage is verified, not trusted  ✅

`JP_COW_ROOT` pointing somewhere that is not a copy-on-write filesystem was indistinguishable from a
working configuration, because **Docker creates a missing bind source as an ordinary directory**.
Project data then lands on the root disk, and mounting the pool later *shadows* it — data loss that
arrives days after the typo, looking nothing like its cause.

The store now proves itself at boot: it checks the filesystem type and then creates, snapshots and
deletes a probe subvolume, so what is verified is the exact operation branching depends on rather
than a proxy for it. Reported rather than fatal, and re-checked on demand, so mounting the filesystem
fixes it without a restart; `create` and `snapshot` refuse until it passes.

Verified by pointing a running instance at `/var/lib/jpcow-typo`: *"is not a btrfs filesystem
(filesystem at /cow is ext2/ext3) … Docker will happily create that path as an ordinary directory, so
this looks like a working setup until project data lands on the root disk."*

**And it found a bug that was already there.** ZFS branching could never have worked: the helper is
the project's Postgres image, which carries `btrfs-progs` and has no `zfs` command at all. The
roadmap called ZFS "untested"; it was broken. `zfsutils-linux` does not belong in every project's
image, so `JP_COW_HELPER_IMAGE` is now required for ZFS and the verification says exactly that.

### Disk-exhaustion policy  ✅

A full disk is the worst thing that can happen here, and worse than in most systems: Postgres does
not degrade when it cannot write, it PANICs; WAL that cannot be archived accumulates, so the disk
fills *faster* once archiving starts failing; and one project's runaway table takes down every other
project on the host.

Two filesystems are sampled — the one Docker puts volumes on, measured from inside a container with a
probe volume so no host path has to be guessed, and the control plane's own directory via `statfs`.
The reserve is the larger of a percentage and a fixed size, because 10% is 400 GB of waste on a 4 TB
disk and 2 GB is a rounding error on a 20 GB VPS.

Below the reserve, anything that allocates is refused with a 507 and a message naming the next
action; deletes are never blocked, because the way out of a full disk must stay open. Backups are a
separate judgement: a local-repository backup is *deferred* 30 minutes rather than failed, since a
failed run that breaks the backup chain turns a disk warning into a data loss.

Verified end to end by raising the reserve until the host was below it: health went `degraded`, the
create request returned 507 with the reserve figures, and the health page drew the filesystem red.

### Major-version upgrades  ✅

Dump and restore, not `pg_upgrade` — forced by the image design rather than preferred. `pg_upgrade`
needs both majors' binaries at once, and justpostgres ships one major per image so a project's
version is pinned by its tag. The cost is downtime proportional to the data; the compensation is that
**the old data directory is never written to**, so recovery is starting the old container again.

Eight checkpointed steps, with the downtime line drawn deliberately: everything before "stop the old
container" is reversible by doing nothing. After it, the handler rolls back itself.

Three things worth recording:

1. **A dump that silently loses something is the failure this product cannot afford.** So the old
   cluster's contents — databases, roles, every table — are recorded before the dump and re-read
   afterwards, and a missing object rolls the upgrade back. Only absences are compared: `reltuples`
   is a planner statistic that reads zero on a freshly restored table, so counts prove nothing.

2. **`stanza-upgrade` works, and that is not the end of the problem.** pgBackRest keeps the old
   backups after the upgrade, under a prior database id. They are still listed, still take up space,
   and cannot restore into the running version — so the recovery window was reporting three backups
   and an earliest point that would have failed. The window now counts only the current database id
   and reports the rest as `strandedByUpgrade`, which the UI names in as many words. This is the
   second half of the version-locking trap: the first half is remembering to upgrade the stanza.

3. **The restore path never validated its target time at all.** It accepted any timestamp, created a
   project, provisioned a container, and failed minutes later inside pgBackRest. A pre-upgrade
   timestamp is exactly the plausible-looking input that hits it. Targets outside the window are now
   refused up front, and the message says when an upgrade is why.

Verified against real containers: 17 → 18 with 12,000 rows across a table, an index, a view, a check
constraint, a second database and a non-default role — all present afterwards, sequences continuing
from the right value, connection string unchanged. Then the failure path twice, with a deliberately
broken target image: failing *before* the downtime line left the project running and untouched, and
failing *after* it rolled back to Postgres 17 with all rows intact and no leftover volumes.

Two bugs found in that second test: the dump volume — a full copy of the database — leaked on every
rollback, and the deliberately retained pre-upgrade volume was being reported as an orphan every ten
minutes, which is how an operator gets trained to delete the one thing standing between them and a
bad upgrade.

### Backups in object storage  ✅

The S3 path existed since M4 and had never been run against a bucket, which made it a claim rather
than a feature. It is now configured from the UI, and it works.

Three things this settled:

1. **The provider is not a detail.** Cloudflare R2 wants a region of `auto`, path-style URIs, and an
   endpoint built from an account id that is not the bucket name and is not shown next to it. Each of
   those is a way to configure backups that look configured and silently never work. The form knows
   all three, so choosing "Cloudflare R2" and typing a bucket, an account id and a token is the whole
   task — and the instructions for finding those are on the page, not in a doc.
2. **pgBackRest has no plaintext mode.** It always speaks TLS to object storage, so a self-hosted
   MinIO on plain HTTP fails with `TLS error … wrong version number`, which reads like a version
   mismatch and is not one. That case now has its own message saying the endpoint needs a
   certificate, even a self-signed one with verification off.
3. **Two places created a project's backup configuration.** Object storage configured in the UI was
   ignored by new projects, because `project-create` had its own copy of the `INSERT` that read the
   old environment variable. The same duplication class that produced four container-spec sites in
   M6. Deleted; there is one function now, and the repository fallback resolves before the container
   is built so `archive_command` and the metadata store cannot disagree.

Verified end to end against MinIO with TLS: connection test passes, and reports the right cause for a
wrong secret, a wrong bucket and a plaintext endpoint. A project moved from local disk wrote 980
objects to the bucket. A project created afterwards went straight there with no further action. And a
point-in-time restore **rebuilt a 200,314-row database entirely from object storage** into a new
project, which is the only test that actually matters.

**Correction (PITR audit).** That restore did not come from object storage. Restore and restore
verification both read every source repository as the local backup volume, and the project in that
test had been *moved* from local disk — so the restore rebuilt it from the pre-move backups still on
the volume, which happened to contain the rows. A project created on S3 could not be restored at all,
and a moved project restored a copy that silently stopped at the moment of the move, while
verification, hardcoded the same way, reported it healthy. Found alongside it:

1. **Configuring object storage repointed existing local projects.** A local project's row stores no
   repository, and the lookup fell through to the *current* default — so after S3 was configured,
   every local project resolved to the bucket. Restores failed with "no backup set found", and any
   container rebuild would have moved `archive_command` to a repository with no stanza.
2. **Moving to object storage always failed.** `stanza-create` ran the instant the container was
   recreated, before Postgres accepted connections ("unable to find primary cluster"), with
   `maxAttempts: 1` and a route that refused to retry once the type read "s3" — leaving the project
   pointed at an empty bucket, unprotected, with no way to finish.
3. **New projects had no recovery point for up to fifteen minutes.** Nothing queued the first full
   backup; it waited for the periodic scheduler sweep while the UI showed archiving as healthy.
4. **A malformed restore body meant "restore everything".** Unparseable JSON fell back to `{}`.

All fixed, plus log-position recovery targets, a configurable `archive_timeout`
(`JP_BACKUP_ARCHIVE_TIMEOUT_SECONDS`), and a warning on the backups page while backups exist only on
the host. Verified end to end against MinIO over TLS from an isolated control plane: time restore
from local disk; local-source restore after object storage is configured; a moved project restored
*including writes made after the move*; an S3-native project restored to a log position and to a
time, each stopping exactly there; restore verification passing for both S3 cases; source
credentials gone from the restored container after it detaches; and a before-window log position, a
time-plus-log-position request and a malformed body each refused up front. The restore-command
construction and backup selection now have unit tests, including one that runs the generated
`restore_command` through `/bin/sh` against a stub to prove only the source repository reaches
pgBackRest.

### Still to do

- Observability dashboards per [ARCHITECTURE §9](ARCHITECTURE.md#9-observability)
- Control-plane backup and restore — the metadata store is a single point of failure
- Audit log surfaced in the UI
- Security review of the container-escape boundary, written up honestly in the docs
- Install story: one command, wildcard TLS setup guide, upgrade guide
- Docs, an honest capacity table, and a benchmark of what a 4 GB VPS actually holds

**Exit:** a stranger provisions justpostgres on a fresh VPS from the README alone, without asking a
question.

---

## Rough shape

| Milestone | Size | Depends on |
|---|---|---|
| M0 Foundations | S | — |
| M1 Provisioning | M | M0 |
| M2 Router + pooler | L | M1 |
| M3 Table view | M | M1 |
| M4 Backups + PITR | L | M1 |
| M5 Branching | M | M4 |
| M6 Extensions | S | M1 |
| M7 REST API + RLS | L | M1, M2 |
| M8 Hardening + 1.0 | M | all |

M3, M4 and M6 are independent of each other and of M2 once M1 lands — the natural parallelisation
points if more than one person is working.

---

## Risks

**The feedback risk, stated plainly.** D4 means months of building before a single external user
touches this. Every assumption in [ARCHITECTURE](ARCHITECTURE.md) — that people want branching, that
the API earns its cost, that container-per-project economics work on a small VPS — stays unfalsified
until 1.0. The cheap partial mitigation is to cut a **public alpha after M4**: provisioning, table
view and PITR. That is not a 1.0 and it is not marketed as one, but it converts the largest
assumptions into evidence while there is still time to act on them.

**The router.** Highest technical risk, discussed above. Mitigated by early sequencing, a pre-agreed
benchmark gate, process isolation for a language swap, and mode 3 as a permanent fallback.

**PostgREST changes the project's identity.** Shipping an auto-generated API on day one invites
direct comparison to Supabase, on Supabase's terms, where a 1.0 will lose. The positioning defence is
that the API is off by default and framed as a bonus over a Postgres host, not as the point. If the
launch narrative slips into "open-source Supabase alternative", the project inherits a feature
scoreboard it cannot win. Worth deciding the launch framing before M7, not after.

**Restore correctness is the whole reputation.** One person who loses data because a restore silently
produced a bad database is worth more damage than a hundred happy users are worth promotion. The
restore-verification job in M4 is not a nice-to-have; automatic periodic proof that backups restore
is the only defensible position for a tool making this promise.

**Scope gravity.** Once the REST API exists, the requests will be for auth, then storage, then
realtime — each individually reasonable, and collectively the thing the README promises not to build.
The [non-goals](../README.md#what-it-is-not) need to be a decision the project defends, not a
placeholder it drifts past.
