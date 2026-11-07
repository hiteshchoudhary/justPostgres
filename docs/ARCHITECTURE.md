# Architecture

This document describes how justpostgres is built and, more importantly, why each choice was
made and what it costs. Nothing here is implemented yet — this is the design being committed
to before code, so that the expensive decisions are argued in text rather than discovered in a
refactor.

---

## 1. Decision log

The five decisions everything else hangs off, with the trade-off accepted in each case.

| # | Decision | Rejected alternative | What it costs us |
|---|---|---|---|
| D1 | **OSS-first, single VPS is the design target.** Hosted service comes later on the same core. | Hosted-first with OSS as a funnel | Fleet/multi-node concerns must be retrofitted, not assumed |
| D2 | **Container per project.** Each project is its own Postgres container and volume. | Database-per-project on a shared cluster | ~23 MiB RAM idle per project (measured in M1); needs a connection router |
| D3 | **PITR via WAL archiving** (pgBackRest), not scheduled dumps. | `pg_dump` on a cron | A backup sidecar path per project; restores locked to the same PG major version |
| D4 | **Full scope at 1.0**: branching, pooling, extensions, and a REST API all ship together. | Thin slice, iterate on feedback | Months of building before real user signal; see [Roadmap §Risks](ROADMAP.md#risks) |
| D5 | **TypeScript end to end.** | Go or Rust control plane | Higher memory floor for the control plane; Node is a weaker fit for the router (see §5) |

Two consequences worth stating plainly, because they shape everything downstream:

**D2 makes Docker a hard dependency.** That is the reason D5 is defensible. Go's single-static-binary
advantage — normally decisive for self-hosted tooling — evaporates when the user must install and run
Docker regardless. What's left is contributor pool and teachability, where TypeScript wins.

**D3 makes branching nearly free.** "Restore to a point in time, into a new project" and "branch this
project" are the same operation with different labels in the UI. Branching is not a separate feature;
it is a second front-end onto the restore path.

---

## 2. Topology

```
                          ┌────────────────────────────────────────┐
   browser ──── :443 ────▶│  Caddy  (TLS termination, ACME)        │
                          └────────────────┬───────────────────────┘
                                           │
                          ┌────────────────▼───────────────────────┐
                          │  control plane  (TypeScript)           │
                          │    HTTP API + React UI                 │
                          │    job runner (backup/restore/branch)  │
                          │    reconciler + Docker driver          │
                          │    HTTP proxy → per-project PostgREST  │
                          │    metadata store (SQLite)             │
                          └────────────────┬───────────────────────┘
                                           │ Docker API (via socket proxy)
          ┌────────────────────────────────┼────────────────────────────────┐
          │                                │                                │
 ┌────────▼──────────┐          ┌──────────▼────────┐          ┌────────────▼──────┐
 │ project_a         │          │ project_b         │          │ project_c         │
 │   postgres:17     │          │   postgres:16     │          │   postgres:17     │
 │   + pgbackrest    │          │   + pgbackrest    │          │   + pgbackrest    │
 │   vol_a           │          │   vol_b           │          │   vol_c           │
 │   PostgREST(lazy) │          │                   │          │                   │
 └────────▲──────────┘          └──────────▲────────┘          └────────────▲──────┘
          │                                │                                │
          └────────────────────────────────┼────────────────────────────────┘
                                           │
                          ┌────────────────┴───────────────────────┐
  psql / app ─── :5432 ──▶│  router + pooler  (TypeScript)         │
                  :6543   │  SNI → username prefix → port fallback │
                          └────────────────────────────────────────┘

      WAL + full/incremental  ────────▶   backup repo:   S3-compatible | local dir
```

Five long-lived processes on the host: Caddy, the control plane, the router, a Docker socket
proxy, and one Postgres container per project. PostgREST containers exist only for projects
that turned the API on.

---

## 3. Control plane

A single Node process serving an HTTP API and the React UI from the same origin.

**Stack.** Hono for the API, React + Vite for the UI built to static assets and served by the API
server, Drizzle for the metadata store, Zod for input validation at every boundary. One container,
one port. Deliberately *not* Next.js: there is no SSR or SEO requirement here, and an SPA plus a
plain API server is a simpler thing to self-host and a much simpler thing to contribute to.

**Metadata store: SQLite, not Postgres.** This looks wrong for a project called justpostgres, and it
is the right call anyway. The control plane's job includes telling you *why your Postgres is down*.
If its own state lives in a Postgres container it manages, then a broken Docker daemon or a full disk
takes down the very UI you need to diagnose it, and bootstrap acquires a circular dependency. SQLite
gives the control plane a hard floor: it always boots, it always renders, and it can always show you
an error. The store is behind Drizzle, so the hosted deployment can swap to Postgres later where a
shared control-plane database is actually required.

**Job runner.** Backups, restores, branch creation and major-version upgrades run for minutes and must
survive a control-plane restart. A `jobs` table with lease-based claiming and heartbeat, polled by an
in-process worker. No Redis, no external queue — adding a broker to a single-VPS product to run a
handful of jobs an hour is not a trade worth making. Jobs are idempotent and resumable; a job that
dies mid-restore leaves an orphaned container that the reconciler cleans up.

**Reconciler.** A periodic loop that diffs desired state (the metadata store) against actual state
(the Docker API) and repairs drift: containers that should be running but aren't, orphans from failed
jobs, volumes with no project. This is the single most important piece of operational hygiene in the
system, because in a container-per-project world the failure mode is always drift.

**Docker access.** The control plane needs the Docker API, which is root-equivalent on the host.
It talks to a socket proxy that allowlists only the endpoints it actually uses (container
create/start/stop/remove/exec/inspect, volume create/remove, image pull). A compromised control
plane is still very bad; it should not additionally be a trivial host takeover.

---

## 4. Data plane: the project container

Each project is one container from a justpostgres image plus one named volume for `PGDATA`.

**Images.** `justpostgres/postgres:16`, `:17`, `:18` — the official Postgres image plus pgBackRest and
the curated extension set, preinstalled but not enabled. Users pick a major version at project
creation and it is pinned for the life of the project until an explicit upgrade.

Provisioning resolves images **local-first**: if the tag is already on the host it is used as-is, and
only a missing image is pulled. This is not just an optimisation — the images are built locally and
published nowhere, so an unconditional pull fails with "pull access denied" on an image sitting right
there. It also means an air-gapped host works, and a pinned tag costs no network round trip.

**pgBackRest lives inside the Postgres container, not in a sidecar.** This is forced, not chosen:
Postgres's `archive_command` is executed as a subprocess *of the Postgres process*, so the archiving
binary must be on the same filesystem and in the same namespace. Putting it in the image rather than
a sidecar also halves the container count, which matters a lot when the whole product is
container-per-project. Scheduled `pgbackrest backup` runs are invoked by the control plane's job
runner via `docker exec`.

**Superuser is granted, and it is a real liability.** Giving the user a genuine superuser role is what
makes this feel like a database rather than shared hosting — it is the entire reason `CREATE EXTENSION`
works. It also means the user can run `COPY ... FROM PROGRAM`, which is arbitrary code execution as
`postgres` inside their container. That is accepted and contained, not prevented:

- `--security-opt no-new-privileges`, `cap_drop: ALL` with only the caps Postgres needs
- hard `--memory` and `--cpus` limits, so one project cannot starve the host
- a dedicated Docker network per project; no container-to-container reachability between projects
- no Docker socket, no host mounts other than the project's own volume
- the container runs unprivileged; superuser inside Postgres is not root on the host

This must be documented prominently rather than buried. Anyone offering *other people* projects on
a shared justpostgres host needs to understand that container escape is the only thing standing
between tenants.

**Credentials.** Each project gets a generated superuser role and password. The control plane stores
them encrypted at rest with a key from `JP_MASTER_KEY` (env, never in the database). The control
plane holding superuser credentials for every project makes it the crown jewels of the deployment —
worth saying out loud, because it sets the bar for how carefully its own auth is built.

**Extensions.** The UI lists the curated set and toggles them with `CREATE EXTENSION`. The wrinkle
worth designing for up front: `pg_cron`, `timescaledb` and `pg_stat_statements` require
`shared_preload_libraries`, which means editing `postgresql.conf` and **restarting the container**.
Enabling those is therefore a job with downtime, not an instant toggle, and the UI must say so before
the user clicks. Extensions that need no preload are instant. TimescaleDB ships as the Apache-licensed
build only; the TSL features are not redistributable here.

---

## 5. The router and pooler

This is the most important component in the system and the riskiest one to build. It deserves the
most design attention before any code is written.

### The problem

Container-per-project means N Postgres instances on one host, but a user expects one clean connection
string. The naive answer — publish a distinct host port per project — produces
`db.example.com:54312`, which is ugly, hostile to corporate firewalls that only allow 5432, and leaks
the internal topology.

### The happy accident

Connection pooling was scoped as a separate feature. It isn't one. Anything that can route a
connection to the right project has already parsed the Postgres wire protocol far enough to pool it.
**Routing and pooling are one component**, and building them together is strictly less work than
building either alone and bolting on the other.

### Routing strategy

Three modes, in preference order, because self-hosted deployments vary enormously in what DNS and
TLS they have available:

1. **SNI (preferred).** `<project_ref>.db.example.com:5432`. Postgres's TLS negotiation begins with an
   `SSLRequest` preamble, after which a normal TLS handshake carries SNI — libpq sends it by default
   since PG 14 (`sslsni=1`). The router reads the SNI hostname, maps it to a project, and splices.
   Clean, standard, and every project gets its own hostname. Requires a wildcard certificate and
   wildcard DNS.
2. **Username prefix (fallback).** `<role>.<project_ref>` in the startup packet, the convention
   Supabase and Supavisor use. Works with no TLS, no wildcard DNS, and ancient clients. The catch:
   the user has superuser and can `CREATE ROLE` anything, so the router must treat the suffix as a
   hint validated against the metadata store, never as trusted input.
3. **Per-project ports (last resort).** For a bare-IP VPS with no domain at all. Ugly but always works,
   and it is also the fallback the whole product degrades to if the router turns out to be a mistake.

That third mode is a deliberate insurance policy. If the custom router fails to reach acceptable
quality, justpostgres still ships — worse, but whole.

### Pooling

Transaction-mode pooling, per project, in the same process. The mechanic is well understood: proxy
messages through, track the transaction status byte in `ReadyForQuery`, and return the server
connection to the pool when it reports idle (`I`). Session-mode is exposed too, because migrations,
`pg_dump`, `LISTEN/NOTIFY`, advisory locks and prepared statements all break under transaction pooling.

Two connection strings are surfaced per project, following the convention people already know:

| | Port | Mode | Use for |
|---|---|---|---|
| Direct | 5432 | session | migrations, `pg_dump`, long-lived app connections |
| Pooled | 6543 | transaction | serverless, Lambda, Vercel, anything that opens many short connections |

### Why build it rather than use PgBouncer

PgBouncer has no dynamic multi-tenant routing; using it would mean one PgBouncer container per
project, adding back the container overhead that container-per-project already costs us. Supavisor
does exactly the right thing but is Elixir, and adding a BEAM runtime to a TypeScript project for one
component is a heavy dependency for a self-hosted single-VPS product.

**The honest risk:** a Postgres wire-protocol proxy in Node is the single most likely thing in this
design to disappoint on throughput and tail latency. Mitigations, in order: the protocol work is
confined to the startup packet and the `ReadyForQuery` byte, with everything else being raw socket
splicing; the router is a separate process, so it can be rewritten in Go or Rust without touching the
rest of the codebase; and mode 3 above means the product survives its failure. Build it early
(see [Roadmap M2](ROADMAP.md)) precisely so this risk is discovered while it is still cheap.

**Measured in M2:** the risk was real but not disqualifying — 54–65% of PgBouncer on simple protocol,
38% on extended. The session path does splice raw bytes after the first `ReadyForQuery` and shows it,
running at 79–98% of PgBouncer; the pooled path cannot, because it has to see every `ReadyForQuery` to
know when a connection is free again. That asymmetry is inherent to transaction pooling, not to this
implementation.

### Two consequences worth stating

**The router is the data path, and does not depend on the control plane.** It reads the metadata store
directly, read-only, rather than asking the control plane over HTTP. Every project on the host is
unreachable while the router is down, so it must not also become unreachable when the control plane is
crashed, upgrading, or simply stopped. SQLite's WAL mode makes concurrent cross-process readers free.

**TLS terminates at the router.** The client's connection is encrypted; the router-to-Postgres hop is
not — `pg_stat_ssl` inside a project reports `ssl=false`, which is correct and not a bug. On a single
host that hop is loopback. It stops being acceptable the moment the router and the projects are on
different machines, which is a hosted-service concern to solve before that happens.

---

## 6. Backups, restore, and branching

One mechanism, three product features.

### Backup

pgBackRest per project, one stanza each, writing to a repository the operator configures once —
an S3-compatible bucket or a local directory. Default schedule: weekly full, daily incremental,
continuous WAL archiving. Retention is configurable and enforced by pgBackRest's own expiry.

The WAL stream is what makes this different from every other self-hosted tool in this space.
Dump-based backups give you an RPO of however long ago the cron ran. Continuous archiving gives you
an RPO measured in seconds.

### Restore is non-destructive by construction

This is the core UX decision, and the one that beats the existing tools. In Coolify the restore
story is a runbook: stop the broken resource, provision a new one, restore into it, repoint your
`DATABASE_URL`, redeploy. Every step is manual and the first one is destructive.

In justpostgres, **a restore always produces a new project.** "Restore to 14:32 yesterday" creates
`myapp-restored-1432` alongside the still-running original. You inspect it, confirm it has what you
need, and then optionally **promote** it — which swaps the connection routing so the new project
answers on the old project's hostname. Nothing is destroyed until you explicitly delete the old one.

In-place restore is **not implemented**. Restore-then-promote covers the same need — the promoted
project answers on the old hostname and port — without a moment where the only copy of the data is
being overwritten. If it is ever added, it belongs behind a confirmation, never as the default path.

### Recovery targets and RPO

A restore stops at a **point in time**, at a **log position** (`16/B374D848`, as printed by
`pg_current_wal_lsn()` or a Postgres log line), or at the end of the archive. A log position is the
precise one: it can stop between two transactions that committed in the same second. pgBackRest only
auto-selects the backup set for *time* targets — for a log position it takes the newest, and if that
backup ended after the requested position Postgres refuses to start. So the control plane picks the
set itself (the newest backup whose stop LSN is at or before the target) and passes `--set`.

The recovery point objective is `archive_timeout`, set from `JP_BACKUP_ARCHIVE_TIMEOUT_SECONDS`
(default 60): a partly filled WAL segment is archived after at most that long, so it bounds what a host
loss can take with it. It is not zero. Zero needs WAL streamed synchronously off the host
(`pg_receivewal` or a synchronous standby), which this design does not do. Backups on the local
repository do not survive the host at all; the backups page says so until object storage is set up.

Every new project takes its first full backup as the last step of provisioning. WAL archived before
that has no base backup to replay onto, so until then there is no recovery point.

### Branching is the same code path

`POST /projects/:id/branches` with no timestamp restores the latest backup plus all WAL; with a
timestamp it restores to that point. The result is a new project, labelled a branch, with a recorded
`parent_project_id` and branch point. The UI presents it as forking; the engine is `pgbackrest restore
--type=time --target=...` into a fresh volume, then starting a container against it.

**This is O(database size).** A 100 GB project takes minutes to branch, not the seconds people expect
from Neon, which has a copy-on-write storage engine we are explicitly not building.

**The fast path.** When `PGDATA` sits on ZFS or btrfs, a branch can instead be a filesystem snapshot
and clone — effectively instant and space-efficient. Postgres is crash-safe, so an atomic snapshot of
a complete `PGDATA` is a recoverable state; the container started from the clone performs normal crash
recovery. This requires the whole data directory on one filesystem, which is already true. Ship
PITR-restore as the always-works baseline and CoW as an opt-in accelerator the installer detects.

**Built and measured in M5.** On btrfs, a 127 MB database branched in 6.3 s against 16 s for the
point-in-time path, with the snapshot itself taking ~150 ms — the rest is container startup, so the
gap widens with database size rather than staying constant. Two subvolumes reported 342 MB each while
the filesystem used 370 MB in total, which is the copy-on-write claim made concrete.

Three details the design did not anticipate:

- **The two strategies answer different questions**, rather than being fast and slow versions of one.
  A snapshot captures *now* and cannot travel backwards; WAL replay reaches any point in the recovery
  window and cannot avoid paying for it. The service chooses by what was asked for, and says which it
  picked.
- **A copy-on-write data directory is presented as an ordinary Docker volume**, using a `local` driver
  bind (`type=none,device=…,o=bind`). That keeps the seam narrow: container specs, mounts and backups
  are identical either way and never learn what is underneath.
- **The privileged helper is not new privilege.** The filesystem commands run in a short-lived
  privileged container, which sounds alarming until you notice the control plane already holds the
  Docker socket — it could start such a container regardless. Doing it narrowly and explicitly is
  better than making the control plane itself privileged.

**The mount is verified at boot, not trusted (M8).** `JP_COW_ROOT` pointing at a path that is not a
copy-on-write filesystem is indistinguishable from a working configuration, because Docker creates a
missing bind source as an ordinary directory. Project data then lands on the root disk, and
remounting the pool later *shadows* it — data loss arriving days after the typo. So the store proves
itself at startup by checking the filesystem type and then creating, snapshotting and deleting a
probe subvolume, and refuses to create or clone anything until it passes. It is reported rather than
fatal, for the same reason Docker being down is: the process that has to explain the problem must
survive it. Verification is retried on demand, so mounting the filesystem fixes it without a restart.

**ZFS needs its own helper image.** The single-image design — the project's Postgres image doubles as
the privileged helper — works for btrfs because `btrfs-progs` is a small Debian package. There is no
equivalent for ZFS: `zfsutils-linux` pulls in a kernel-module toolchain that has no business in every
project's image. So `JP_COW_HELPER_IMAGE` must point at an image carrying the ZFS userland; the
privileged helper already sees the host's `/dev`, so `/dev/zfs` is reachable once the binary exists.
M8's verification names this precisely instead of failing at the first branch.

**Object storage is configured at runtime, not at boot (M8).** The repository for a project is stored
on its own row, encrypted, which was always the design — it exists so that changing the global
default cannot silently repoint an existing project at a repository that does not hold its backups.
M8 made that seam useful: S3, R2 or any S3-compatible bucket is configured from the UI, new projects
adopt it, and an existing project moves through an explicit job that creates a stanza in the bucket,
proves archiving reaches it, and takes a full backup before reporting success. Until that backup
lands the project is `awaitingFirstBackup` and restores refuse — the pointer moving is not the
backups moving, and the UI must not imply otherwise.

### What M4 actually taught

**`archive-push` writes to every configured repository.** This is the single most important thing
learned building the restore path. A restored cluster needs the *source* repository during recovery
and its *own* afterwards, and the obvious way to arrange that — configure both as repo1 and repo2 —
silently breaks archiving, because the restored cluster then tries to push its own WAL into the
source project's repository under a stanza that does not exist there. The source repository is
therefore named only on the `restore_command` line, never in the container's environment.

That rule has two consequences learned later. The restore must read the source's *actual*
repository — its bucket when it is on object storage, not its backup volume, which for a project moved
to S3 still holds the stale pre-move backups and will restore them without complaint. And because the
container's environment still describes the restored project's *own* repo1, `restore_command` clears
every `PGBACKREST_REPO1_*` variable with `env -u` before naming the source. S3 credentials cannot go on
pgBackRest's command line at all (it refuses secret options there), so they travel in the recovering
container's environment under `JP_RESTORE_SOURCE_*` names pgBackRest does not read, are mapped onto
pgBackRest's names inside `restore_command`, and disappear when the container is rebuilt after
recovery. `restore_command` itself is reset once recovery is over.

**A restore is not finished when the data is back.** The restored project still depends on the source
project's repository volume until it has taken a full backup of its own; deleting the source before
that would break it. The job detaches that dependency as an explicit final step.

### The version-locking trap

Physical backups are tied to the Postgres major version that wrote them. After a major-version
upgrade, the old repository cannot restore into the new binary. So an upgrade must: run the upgrade,
start a **new stanza** for the new version, take an immediate full backup, and keep the old repository
read-only until its retention window expires. Until that first new backup completes, the project has
no valid recovery point — the UI must show that state loudly rather than implying protection that
does not exist.

---

## 7. The REST API layer

PostgREST per project, started lazily and only for projects that enable it. HTTP requests arrive at
Caddy, are forwarded to the control plane's proxy, and routed by hostname
(`<project_ref>.api.example.com`) to that project's PostgREST container.

### The scope line: we issue keys, we do not manage users

This is the decision that keeps "just Postgres" honest. A full user-authentication service — signup,
login, password reset, email verification, OAuth providers, session management — is GoTrue, and
building it is how this project becomes a worse Supabase.

Instead:

- Each project gets a **JWT secret**.
- justpostgres issues an **anon key** and a **service_role key**, both JWTs signed with it.
- PostgREST validates the JWT and sets the Postgres role and claims per request.
- **RLS policies do the actual authorization**, in the database, where they belong.
- Users who need real end-user identity **bring their own provider** — Clerk, Auth0, WorkOS, Better
  Auth, anything that can sign a JWT with the project secret. Their claims flow into RLS unchanged.

This gives roughly 90% of the practical value of a bundled auth service for a small fraction of the
build, and it is a more honest fit for a tool whose thesis is that you already have opinions about
your stack.

The UI ships an **RLS policy editor** — list policies per table, a guided builder for the common
shapes (owner-only rows, tenant isolation, public read), and raw SQL for anything else — plus a
warning banner on any table that has the API enabled and RLS disabled, which is the single most
common way people leak their entire database.

---

## 8. Table view and SQL editor

Runs in the control-plane UI; queries execute through the control plane against the project database
using the stored project credentials.

- **Schema tree** — databases, schemas, tables, views, columns, indexes, foreign keys.
- **Table browser** — server-side pagination (keyset, not `OFFSET`, so it stays usable on large
  tables), column filters, sort, inline cell editing with optimistic update, insert and delete rows.
- **SQL editor** — CodeMirror 6 with Postgres syntax and schema-aware completion, results grid,
  multi-statement execution, `EXPLAIN`/`EXPLAIN ANALYZE` rendering, CSV export.
- **Guardrails** — a statement timeout on every UI-issued query, a row cap on result sets, and an
  explicit confirmation on `UPDATE`/`DELETE` without a `WHERE` clause.

Deliberately not a full IDE. The bar is "I can check my data and run a query without installing
TablePlus", not "I can replace DBeaver".

**Built in M3, with three decisions worth recording:**

**Values travel as text, both ways.** The control plane asks Postgres for the text it would render
rather than letting the driver coerce into JS types, so an `int8` past `Number.MAX_SAFE_INTEGER`, a
`numeric` with more precision than a double, and a timestamp's exact fractional seconds all survive
the trip. The cost is that the catalog queries get strings too — a boolean arrives as `"f"`, which is
truthy — and that cost was paid in a real bug before it was paid in a helper function.

**Editing requires a primary key, and there is no fallback.** Some tools address rows by `ctid` so
that a primary-key-less table stays editable. That works until a concurrent update moves the row, at
which point the edit silently lands somewhere else. Refusing to edit is the worse feature and the
better guarantee.

**The browser connects to the container, not through the router.** It needs session semantics — a
`SET statement_timeout`, a transaction around `EXPLAIN ANALYZE` — which transaction pooling
explicitly does not provide. Going direct also means the data browser still works when the router is
down.

---

## 9. Observability

Per project, surfaced in the UI rather than requiring a Prometheus stack: connection count against
`max_connections`, database and volume size with growth trend, `pg_stat_statements` top queries by
total and mean time, cache hit ratio, longest-running query, WAL archiving lag, last successful
backup and the current recovery window, and index health (unused and missing-index hints).

Backup status deserves special treatment: a project whose WAL archiving has silently been failing
for a week looks completely healthy right up to the moment you need it. Archiving failure is an
alert-level condition, not a metric.

---

## 10. Metadata model

Sketch, not final DDL.

```
projects            id, ref, name, pg_major, image, status, container_id, volume_id,
                    cpu_limit, mem_limit, created_at, deleted_at
                    parent_project_id, branch_point (null unless a branch)
credentials         project_id, role, password_enc, is_primary
backup_configs      project_id, repo_type(s3|local), repo_config_enc, schedule,
                    retention_full, retention_wal, stanza, pg_major
backups             project_id, stanza, type(full|incr|diff), lsn_start, lsn_stop,
                    started_at, finished_at, size_bytes, status
recovery_windows    project_id, earliest_recoverable, latest_recoverable  (derived)
extensions          project_id, name, version, enabled_at, needs_preload
api_configs         project_id, enabled, jwt_secret_enc, anon_key, service_key,
                    postgrest_container_id
routes              project_id, hostname, mode(sni|username|port), port
jobs                id, type, project_id, payload, state, lease_owner, lease_expires_at,
                    attempts, last_error, created_at
admins              id, email, password_hash, role, totp_secret_enc
settings            key, value, updated_at      -- holds the unclaimed setup token
audit_log           actor, action, project_id, payload, ip, at
```

`audit_log` is not optional. A tool that holds superuser credentials for every database on the box
needs to be able to answer "who deleted that project".

---

## 11. The path to hosted

D1 puts the hosted service after the OSS, but a few seams are worth leaving open now, because they
are cheap to leave and expensive to cut later:

- **Metadata store behind Drizzle**, so single-node SQLite becomes shared Postgres without a rewrite.
- **A `node_id` column on `projects` from day one**, even when there is only ever one node. Retrofitting
  a fleet concept into a schema that assumes locality is the classic version of this mistake.
- **The Docker driver behind an interface** (`create`, `start`, `stop`, `remove`, `exec`, `inspect`),
  so a future driver can target a remote host or a different runtime.
- **Quotas and limits as first-class fields** on projects, not hardcoded, so the paid tiers of a hosted
  service are configuration rather than a fork.

Explicitly *not* built now: billing, organisations and teams, per-tenant rate limiting, and multi-node
scheduling. Those are hosted-service concerns and building them speculatively would violate D1.

---

## 12. Open questions

Genuinely undecided; each needs an answer before the milestone that depends on it.

1. ~~**Control-plane authentication.**~~ **Answered in M1: single administrator.**
   One account, created on first run, holding full control of every project on the host. Sessions are
   cookie-based with the token hashed at rest, scrypt password hashing, and a per-address login
   lockout.

   Creating that account needs a **one-time setup token**, minted and logged on first boot and
   destroyed in the same transaction that creates the admin. Without it, "first run creates the
   account" means the first request to reach a public IP owns every database on the host — there is
   no default password to leak, but the window between `docker compose up` and the operator opening
   a browser is an unauthenticated land grab. Reprinted on every boot while the install is
   unclaimed, because a token printed once has scrolled away by the time anyone looks. Multi-user stays out of 1.0 — it implies invitations, per-project permissions and an
   organisation model, which is the hosted service arriving early. The `admins` table holds more than
   one row by construction, so adding users later is a migration rather than a rewrite.
2. ~~**How much memory is the real floor per project?**~~ **Answered in M1: ~23 MiB idle.**
   Measured with three idle projects on Docker Desktop (arm64), no client connections: 21.8, 22.3 and
   24.4 MiB RSS, against a 73 MiB control plane. That is well under the 50–100 MB originally assumed,
   so the container-per-project economics are better than the design budgeted for.

   The number is honest but narrow, and the README says so: idle RSS is not capacity. Each client
   connection is a backend process, `shared_buffers` grows the working set, and the real ceiling on a
   host is connections and working set, not idle footprint. A load-based figure belongs in M8.
3. ~~**Does the Node router hold up?**~~ **Answered in M2: yes, with one number to watch.**
   Against PgBouncer, both containerised on the same path: 54–65% of its throughput on simple-protocol
   select-only, +1.72 ms p99 over a direct connection, 78% on connection churn. All inside the
   pre-agreed pass bands. **Extended protocol is the exception at 38%**, which is the "acceptable,
   with a note" band — and extended protocol is what real drivers use. The cause is structural: five
   messages per transaction instead of one, so the JavaScript framing cost is paid five times as
   often. It is the first thing a compiled rewrite would fix, and the router stays a separate process
   and image so that stays a cheap decision. See [ROADMAP M2](ROADMAP.md) for the full table.
4. ~~**Backup repository sharing.**~~ **Answered in M4: one repository per project.**
   Not for the reason expected. Per-stanza retention would have worked fine in a shared repository —
   the deciding factor is that `archive_command` runs as a subprocess of Postgres, so the repository
   must be reachable from inside the project's own container, where the user holds superuser and can
   execute arbitrary code. A shared repository mount is a cross-project read of everyone else's
   backups. The same reasoning makes S3 a documented option rather than the default: credentials that
   reach a container reach the whole bucket unless scoped per prefix. pgBackRest's TLS server mode is
   the proper multi-tenant answer, and is not built.
5. **What happens on host disk exhaustion?** The single most likely real-world outage in a
   container-per-project design, and it takes down every project at once. Needs a reserved-headroom
   policy and hard per-volume limits.
