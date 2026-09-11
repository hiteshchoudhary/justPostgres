# Security

What justpostgres protects, what it does not, and what you have to decide yourself.

This is written for the person running it, not for a compliance questionnaire. Where something is
weak, it says so. Where a default is permissive, it says why and what to change.

---

## The one-paragraph version

justpostgres gives every project a **real Postgres superuser**. That is the point of the product —
it is what makes `CREATE EXTENSION` work — and it means anyone with a project's connection string can
run arbitrary code inside that project's container, via `COPY ... FROM PROGRAM` and several other
routes. Nothing here tries to prevent that. **The container boundary is the security boundary**, and
on a shared host, container escape is the only thing standing between one user's project and
another's. If you are giving projects to people you do not trust, read all of this.

If you are running it for yourself, the threat model is much smaller: mostly, do not put the control
plane on the public internet, and firewall the project port range.

---

## What holds a project in

Verified against a running container, not just intended:

| Control | Setting | Why |
|---|---|---|
| No privilege escalation | `no-new-privileges` | setuid binaries cannot gain more than the container has |
| Capabilities dropped | `CapDrop: ALL`, then only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | the five the official Postgres image needs to drop from root to `postgres` |
| Not privileged | `Privileged: false` | superuser in Postgres is not root on the host |
| Memory ceiling | `--memory`, default 512 MiB | one project cannot starve the host |
| CPU ceiling | `--cpus`, default 1.0 | same |
| Process ceiling | `PidsLimit: 512` | the one exhaustion memory and CPU limits miss — a fork bomb |
| Own network | one Docker network per project | no name resolution or direct routing between projects |
| No Docker socket | never mounted into a project | a project cannot ask Docker for anything |
| No host mounts | only its own two volumes | no path to the host filesystem |

**The container's init process runs as root** (the official image starts as root and drops to
`postgres` with gosu). With capabilities dropped and `no-new-privileges` set, that root is
substantially declawed — but there is **no user-namespace remapping**, so container root is host
UID 0 if the kernel boundary is ever crossed. If you host untrusted tenants, turn on
[`userns-remap`](https://docs.docker.com/engine/security/userns-remap/) in the Docker daemon. It is
the single highest-value thing you can add, and justpostgres does not require any change to work
under it.

---

## Known gaps

Ordered by how much they should worry you.

### 1. Project database ports are published on every interface

**This is the one to act on.** Each project's Postgres is published on a host port in
`JP_PORT_RANGE_START`–`JP_PORT_RANGE_END` (default 55000–55999), bound to `0.0.0.0`. On a VPS with no
firewall, **every project's database answers the internet on a high port**. SCRAM authentication is
still in the way, so this is exposure rather than compromise — but a database reachable from the
internet is a database being brute-forced, and it widens the blast radius of any future
pre-authentication vulnerability in Postgres.

It is also, on a Linux host, what lets one project reach another: containers can reach the host
gateway, so project A can open a TCP connection to project B's published port even though the two are
on separate Docker networks. Verified — the per-project network stops name resolution and direct
container-to-container routing, and does not stop this.

**What to do, in order of preference:**

1. Firewall the port range so only the router reaches it. On a single host, this costs one rule.
2. If the control plane and router run on the host rather than in containers, set
   `JP_PROJECT_BIND_ADDR=127.0.0.1`. That closes it completely.
3. Accept it, knowingly, on a host where you are the only user.

The default stays permissive because a containerised router reaches projects through the host
gateway, and binding to loopback would cut it off — a change that would silently break every routed
connection string. The control plane warns about this at every boot.

**The real fix, not yet built:** attach the control plane and the router to each project's network
and stop publishing project ports altogether. The direct-port endpoint is already documented as a
fallback from before the router existed ([ARCHITECTURE §5](ARCHITECTURE.md#5-the-router-and-pooler)),
so removing it costs little. It touches the data path for every feature, so it is a change to make
deliberately and verify, not to slip into a hardening pass.

### 2. The control plane is reachable from inside a project container

For the same reason: containers can reach the host gateway. A project with arbitrary code execution
— which is every project, by design — can reach the control plane's HTTP port.

It cannot do much with it. Every endpoint but health and login requires a session; login is rate
limited per address; and setup requires the one-time token. But it is reachable, and it is why the
compose file binds the control plane to `127.0.0.1` by default and expects a TLS proxy in front.
Do not change that binding to `0.0.0.0` on a host running projects for other people.

### 3. The control plane holds every project's superuser credentials

They are encrypted at rest with AES-256-GCM under `JP_MASTER_KEY`, which lives in the environment and
never in the database. That protects against someone reading the SQLite file — a stolen backup, a
snapshot, a misplaced volume. It does not protect against someone who has compromised the running
process, because it has the key.

A compromised control plane is total compromise of every database on the host. That is inherent to
what it does, and the reason it talks to Docker through a socket proxy that allowlists only the
endpoints it uses rather than holding the raw socket.

**`JP_MASTER_KEY` has no recovery.** Lose it and every stored credential is permanently unreadable —
the databases keep running, and nothing can authenticate to them. Store it where you store your other
secrets, and specifically *not* beside the control-plane backups it decrypts.

### 4. Object storage credentials are as powerful as the bucket policy allows

Backup credentials are stored encrypted under `JP_MASTER_KEY`, but they are handed to **every project
container** as environment variables, because `archive_command` runs as a subprocess of Postgres and
inherits them. Any project with superuser — which is every project — can read them.

That means a single key with account-wide access lets one project reach every other project's
backups. Scope the token to one bucket, and give it object read, write and delete on that bucket
only. Do not reuse a key that has other permissions attached.

Per-project prefixes stop one project's *retention* from expiring another's, which is a different
problem and one justpostgres does solve.

### 5. The copy-on-write helper runs privileged

Branching on btrfs or ZFS runs filesystem commands in a short-lived privileged container with only
the CoW root bind-mounted. This sounds worse than it is: the control plane already holds Docker API
access, which is root-equivalent, so it could start such a container regardless. Doing it narrowly
and briefly is better than running the control plane itself privileged. It is off unless you set
`JP_COW_DRIVER`.

### 6. One administrator, one password

There are no roles, no per-project permissions, and no second factor. The `admins` table holds a
TOTP column that nothing uses yet. Multi-user is deliberately out of 1.0
([ARCHITECTURE §12](ARCHITECTURE.md#12-open-questions)) — it implies invitations, permissions and an
organisation model, which is the hosted service arriving early.

What is there: scrypt password hashing, session tokens hashed at rest, per-address login lockout, and
both failed logins and failed setup attempts written to the audit log.

**There is no password reset, and recovery needs the host.** A reset link requires an email channel
this product does not have, and a security question is worse than nothing — so a forgotten password
is recovered with `reset-admin`, run on the host, which removes the account and lets the instance be
claimed again through the ordinary first-run flow. That deliberately sets the bar at shell access:
anyone with it could edit the SQLite file by hand anyway, and anyone without it cannot get in by
forgetting a password. The reset is audited, and it never touches project credentials — those stay
encrypted under `JP_MASTER_KEY`, which the command neither knows nor needs.

---

## Claiming a fresh instance

There is no default account and no default password. The first boot mints a one-time setup token,
prints it to the log, and keeps printing it on every boot until someone uses it:

```bash
docker compose logs control-plane | grep jp_setup
```

`/setup` will not create the administrator without it. Without that token, "first run creates the
account" means the first HTTP request to reach a public IP owns every database on the host — the
window between `docker compose up` and you opening a browser is an unauthenticated land grab. The
token is compared in constant time and destroyed in the same transaction that creates the account.

Set `JP_SETUP_TOKEN` to choose the value yourself when a configuration manager provisions the host.

---

## The REST API, if you turn it on

Off by default, per project. When enabled:

- **No table is reachable until you expose it.** `anon` is granted nothing at all — a deliberate
  divergence from Supabase, where `anon` starts with schema-wide access and safety depends on
  remembering to enable row-level security.
- Exposing a table grants access, enables RLS and creates a policy **in one transaction**, so
  "reachable but unprotected" is not a state you can reach by forgetting a step.
- Two keys are issued: `anon` and `service`. **The service key bypasses RLS entirely.** It belongs on
  a server, never in a browser, never in a mobile app.
- Rotation is immediate and total: the old keys stop working the moment the container restarts. There
  is no grace period, because rotation exists for the case where a key has leaked.
- PostgREST is published on `127.0.0.1` only; the control plane's proxy is the route in.

Identity comes from whatever provider signs a JWT with the project's secret. justpostgres issues keys
and installs `auth.uid()`, `auth.role()` and `auth.claim()`; your policies do the deciding.

---

## What gets logged

The audit log records who did what, from which address: sign-ins and failed sign-ins, project
lifecycle, credential and API-key reveals, schema and security changes, backups and restores,
upgrades, and every row edit made through the UI. It is visible under **Instance** in the UI.

**SQL text is deliberately not recorded.** A `WHERE` clause routinely contains personal data, and
putting it in a table that outlives the project would make the audit log a liability. What is
recorded is that a query ran, how many statements, and which commands.

Passwords never appear in the log or the audit table, including in failed attempts.

---

## Reporting a vulnerability

This is a pre-1.0 project with no security team. If you find something, open an issue for anything
already public, and for anything exploitable contact the maintainers privately first. Nothing here
has had an external audit; this document is what a careful read of our own code found.

## Fixed issues

- **Session cookie overwrite via the REST proxy** (v0.1.1). The proxy that serves a project's API at
  `/rest/<ref>/` forwarded upstream `Set-Cookie` headers unchanged. Because that path shares the
  admin origin and the session cookie is `Path=/`, a project — which can emit response headers
  through PostgREST's `response.headers` GUC — could overwrite the admin's session cookie. The
  inbound `Cookie` header was already stripped; the outbound `Set-Cookie` now is too. Reported
  privately, following this document; fixed in v0.1.1.
  <!-- credit: swap in the reporter's name/handle once they confirm it -->
  Thanks to the external researcher who disclosed it responsibly.
