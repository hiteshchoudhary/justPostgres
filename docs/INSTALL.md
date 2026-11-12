# Installing justpostgres

Three ways to run it. Pick one and follow it top to bottom — each is complete on its own.

| | Use this when | You get |
|---|---|---|
| **[0. Paste a compose file](#0-paste-a-compose-file)** | Your host has a "paste Docker Compose" box | `http://YOUR_IP:8080`, no shell needed |
| **[A. Locally](#a-run-it-locally)** | Trying it out, or developing against it | `http://localhost:3000` |
| **[B. On a VPS, no domain](#b-run-it-on-a-vps-without-a-domain)** | You have a server but no DNS yet | `http://YOUR_IP:8080` |
| **[C. On a VPS with a domain](#c-run-it-on-a-vps-with-a-domain-and-https)** | Anything other people will use | `https://db.example.com` |

Everything below has been run start to finish, on the versions in this repo.

---

## Before any of them

You need **Docker Engine with the Compose plugin**, and nothing else. No Kubernetes, no Node, no
Postgres on the host.

```bash
docker --version && docker compose version
```

If Docker is missing on a Linux server:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in
```

---

# 0. Paste a compose file

For hosts with a Docker Compose box — Hostinger, Coolify, Dokploy, Portainer — or anywhere you would
rather not clone a repository. Nothing is built: every image is pulled from Docker Hub.

### 1. Copy the file

Take [`docker-compose.paste.yml`](../docker-compose.paste.yml) from this repository and paste the
whole thing into your host's compose box.

### 2. Change two lines

Both are marked in the file, and nothing else needs touching.

**`JP_MASTER_KEY`** appears twice — once for the control plane, once for the router, and **they must
match**. Generate one:

```bash
openssl rand -base64 32
```

It encrypts every project's database password, and there is no recovery. Save it in a password
manager before you deploy.

Connection strings use whatever address you open the UI on: browse to the IP and you copy an IP,
browse to a domain and you copy the domain. Set **`JP_PUBLIC_HOST`** only to pin a different name.

### 3. Deploy

Your host runs `docker compose up`. First start pulls about 900 MB of images, so give it a few
minutes.

### 4. Claim it

There is no default account. Find the one-time setup token in the control plane's logs. On the
server's shell (not inside a container — the panel's container terminal has no `docker`), this works
from any directory:

```
docker logs $(docker ps -qf name=control-plane) 2>&1 | grep jp_setup
```

Most panels also have a log viewer — search it for `jp_setup`. Then open `http://YOUR_SERVER_IP:8080` and
create your account with that token.

### 5. Firewall the project ports

Projects publish their Postgres on ports **55000–55999** on every interface. Your clients do not need
those — they connect through the router on 5432 and 6543. Close the range in your provider's
firewall. See [SECURITY.md](SECURITY.md) for why this matters.

### What this option cannot give you

- **No HTTPS.** The admin login crosses the network in the clear. Fine for a server only you use;
  for a team, do [option C](#c-run-it-on-a-vps-with-a-domain-and-https) and put a certificate in front.
- **It needs the Docker socket.** justpostgres creates project containers through the Docker API. If
  your host is a constrained PaaS that blocks socket mounts, this will not start, and no
  configuration fixes it — you need a VPS where you control Docker.

---

# A. Run it locally

For a laptop or a dev box. Takes about ten minutes, most of it building images.

### 1. Get the code

```bash
git clone https://github.com/justpostgres/justpostgres.git
cd justpostgres
```

### 2. Create `.env`

```bash
echo "JP_MASTER_KEY=$(openssl rand -base64 32)" > .env
```

That is the only required setting. It encrypts every project's database password.

> **Keep this key.** There is no recovery. If you lose it, your databases keep running and nothing —
> including justpostgres — can authenticate to them again. For a throwaway local instance you can afford to
> lose it; for anything you care about, put it in your password manager now.

### 3. Build the Postgres images

```bash
images/postgres/build.sh
```

Builds `justpostgres/postgres:16`, `:17` and `:18` — the official images plus pgBackRest, pgvector,
PostGIS and pg_cron. About 2.7 GB and a few minutes. Just one version is fine:

```bash
images/postgres/build.sh 17
```

**Do this before creating a project.** The images are built locally and published nowhere, so a
project on a major you have not built fails with a pull error.

### 4. Start it

```bash
docker compose up -d --build
docker compose ps
```

Three services, `control-plane` showing `(healthy)`.

If port 3000 is already taken, put `JP_HTTP_PORT=3300` in `.env` and run `docker compose up -d`
again.

### 5. Claim it

```bash
docker compose logs control-plane | grep jp_setup
```

Open **http://localhost:3000**, paste that token with the email and password you want. There is no
default account, and the token stops the first thing that reaches the page from taking ownership.

### 6. Create a project

**New project** in the UI. A minute later you have connection strings on `localhost:5432` (session)
and `localhost:6543` (pooled).

**Stopping and starting:**

```bash
docker compose stop      # pause; everything is still there
docker compose up -d     # resume
docker compose down      # remove containers, keep all data
docker compose down -v   # delete everything, including your databases
```

---

# B. Run it on a VPS, without a domain

Reached at `http://YOUR_SERVER_IP:8080`. **No HTTPS** — the admin login and your database passwords
cross the network in the clear. Fine for a private network, a VPN, or a server only you use. If other
people will log in, do [option C](#c-run-it-on-a-vps-with-a-domain-and-https) instead.

### 1. Get the code

```bash
git clone https://github.com/justpostgres/justpostgres.git
cd justpostgres
```

### 2. Find your server's public IP

```bash
curl -s ifconfig.me
```

Write it down — the next step needs it, and connection strings are built from it.

### 3. Create `.env`

```bash
cat > .env <<'EOF'
JP_MASTER_KEY=REPLACE_ME
JP_BIND_ADDR=0.0.0.0
JP_HTTP_PORT=8080
EOF

# generate the key and drop it in
sed -i "s|JP_MASTER_KEY=REPLACE_ME|JP_MASTER_KEY=$(openssl rand -base64 32)|" .env
chmod 600 .env
cat .env
```

What each one does:

| Setting | Why it is there |
|---|---|
| `JP_MASTER_KEY` | Encrypts every project's password. **No recovery if lost** — copy it somewhere safe. |
| `JP_BIND_ADDR=0.0.0.0` | Makes the UI reachable from outside the server. The default is loopback only. |
| `JP_HTTP_PORT=8080` | The port you will open in a browser. Any free port works. |

### 4. Build the images and start

```bash
images/postgres/build.sh
docker compose up -d --build
docker compose ps
```

### 5. Open the firewall

```bash
ufw allow 22/tcp                 # do not lock yourself out
ufw allow 8080/tcp               # the UI
ufw allow 5432/tcp               # database connections (session)
ufw allow 6543/tcp               # database connections (pooled)
ufw deny 55000:55999/tcp         # see the warning below
ufw enable
```

**The `deny` line matters.** Every project also publishes its Postgres directly on a port in
55000–55999, on all interfaces. Without that rule, each database answers the whole internet on a high
port. Your clients do not need those ports — they connect through 5432 and 6543.

Some VPS providers (AWS, GCP, Oracle) have their own firewall in front of the machine. Open 8080,
5432 and 6543 there too, and leave 55000–55999 closed.

### 6. Claim it

```bash
docker compose logs control-plane | grep jp_setup
```

Open **http://YOUR_SERVER_IP:8080** and paste the token with your email and password.

### 7. Create a project

Connection strings come back with your IP already in them:

```
postgresql://postgres.abc123:PASSWORD@203.0.113.10:5432/postgres   # session
postgresql://postgres.abc123:PASSWORD@203.0.113.10:6543/postgres   # pooled
```

The project is identified by the **username suffix** (`postgres.abc123`), which is how every project
answers on one port without per-project DNS.

### Moving to a domain later

Nothing is lost. Point DNS at the server, then follow [option C](#c-run-it-on-a-vps-with-a-domain-and-https)
— keep the same `.env` and the same `JP_MASTER_KEY`, add `JP_DOMAIN`, remove `JP_PUBLIC_HOST` if you
had set it, and remove `JP_BIND_ADDR`. Your projects and data carry over.

---

# C. Run it on a VPS, with a domain and HTTPS

The full setup: a real certificate, renewed automatically, and the control plane not exposed directly.

### 1. Point DNS at the server

Create an **A record** for the hostname you want, pointing at the server's IP:

```
db.example.com.    A    203.0.113.10
```

Wait for it to resolve before continuing — the certificate is issued by proving control of this name,
and that check fails if DNS has not propagated:

```bash
dig +short db.example.com
```

That must print your server's IP.

### 2. Get the code

```bash
git clone https://github.com/justpostgres/justpostgres.git
cd justpostgres
```

### 3. Create `.env`

Replace `db.example.com` with your hostname:

```bash
cat > .env <<'EOF'
JP_MASTER_KEY=REPLACE_ME
JP_DOMAIN=db.example.com
EOF

sed -i "s|JP_MASTER_KEY=REPLACE_ME|JP_MASTER_KEY=$(openssl rand -base64 32)|" .env
chmod 600 .env
cat .env
```

| Setting | Why it is there |
|---|---|
| `JP_MASTER_KEY` | Encrypts every project's password. **No recovery if lost.** |
| `JP_DOMAIN` | **The hostname Caddy gets a certificate for.** This is the one the browser uses. |

There is no `JP_BIND_ADDR` here on purpose. The control plane stays on loopback and Caddy is the only
way in.

### 4. Build the images

```bash
images/postgres/build.sh
```

### 5. Start, with the TLS overlay

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.tls.yml ps
```

Two compose files: the base stack, plus an overlay that adds Caddy on ports 80 and 443 and removes
the control plane's own published port.

That command is long, so put it in a shell alias or export the choice once per session:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml
docker compose up -d --build      # now picks up both files
docker compose logs -f caddy
```

Caddy requests a certificate from Let's Encrypt on the first request and renews it without being
asked. Nothing to configure and no certbot.

### 6. Open the firewall

```bash
ufw allow 22/tcp
ufw allow 80/tcp                 # required: Let's Encrypt validates over port 80
ufw allow 443/tcp                # the UI
ufw allow 5432/tcp               # database connections (session)
ufw allow 6543/tcp               # database connections (pooled)
ufw deny 55000:55999/tcp         # projects' direct ports; clients do not need them
ufw enable
```

**Port 80 must stay open** even though everything redirects to HTTPS. That is how the certificate is
issued and renewed.

### 7. Claim it

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml logs control-plane | grep jp_setup
```

Open **https://db.example.com** and paste the token.

### 8. Create a project

```
postgresql://postgres.abc123:PASSWORD@db.example.com:5432/postgres   # session
postgresql://postgres.abc123:PASSWORD@db.example.com:6543/postgres   # pooled
```

### If the certificate does not appear

`docker compose logs caddy` says why. Nearly always one of:

- **DNS is not pointing here yet.** `dig +short db.example.com` must return this server's IP.
- **Port 80 is closed**, in `ufw` or in the provider's firewall.
- **Something else already has port 80 or 443** — an existing nginx or Apache. Stop it, or use it as
  the proxy instead (see [Using your own reverse proxy](#using-your-own-reverse-proxy)).
- **Rate limited.** Let's Encrypt limits repeated failures for the same name. Wait an hour.

To test the whole setup without a domain, set `JP_DOMAIN=localhost`. Caddy then issues its own
certificate instead of contacting Let's Encrypt.

---

## After installing — do these two things

Both apply to all three options.

### Send backups off the machine

Backups on the same disk as the database survive a dropped table and nothing else. Not the host
dying, not the disk filling.

Go to **Instance → Backups in object storage**, pick Cloudflare R2, Amazon S3 or any S3-compatible
provider, and follow the steps shown on that page. Test the connection before saving. New projects
use it automatically; existing ones get a **Move to object storage** button on their Backups tab.

Scope the access token to one bucket. Those credentials reach every project container, so a key with
account-wide access lets one project read every other project's backups.

### Save the control plane's own database

It records which projects exist and holds their encrypted credentials. Lose it and the databases keep
running with nothing able to reach them.

It backs itself up every six hours, and **Instance → Metadata store backups** lets you download one.
Copy those off the server. They do **not** contain `JP_MASTER_KEY` and are useless without it, so keep
the key somewhere else.

---

## Upgrading justpostgres

```bash
cd justpostgres
git pull
docker compose up -d --build          # add -f docker-compose.tls.yml if you use option C
```

Schema migrations run at startup. Your running projects are untouched — they are separate containers,
and restarting the control plane does not interrupt a live database connection.

**Upgrading Postgres itself** is separate, done per project on its **Version** tab. Build the target
image first:

```bash
images/postgres/build.sh 18
```

It dumps the database out of the old version and loads it into the new one, so downtime is
proportional to your data. The old data directory is kept afterwards, untouched, and the screen
explains what you are agreeing to before you confirm.

---

## Using your own reverse proxy

If you already run nginx, Traefik or a load balancer, skip the TLS overlay, use the base
`docker-compose.yml`, and proxy to the control plane on `127.0.0.1:3000`.

Add one setting so the audit log records real client addresses:

```bash
JP_TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

Without it, `X-Forwarded-For` is ignored and every audit entry shows the proxy's address. Set it
**only** to where your proxy connects from — anything covered by this list can forge a client address,
and the login lockout is keyed on that address.

nginx:

```nginx
server {
    server_name db.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Optional: wildcard TLS for the databases

Separate from the control plane's certificate. With a wildcard certificate the router identifies
projects by **TLS SNI**, so clients connect to `abc123.db.example.com` instead of using the
`postgres.abc123` username form.

```bash
JP_ROUTER_TLS_CERT=/etc/justpostgres/tls/fullchain.pem
JP_ROUTER_TLS_KEY=/etc/justpostgres/tls/privkey.pem
JP_ROUTER_DOMAIN_SUFFIX=db.example.com
```

Mount those files into the router service and add a `*.db.example.com` record. Without them the
username form is the only way in, which works everywhere and needs no extra DNS.

---

## Sizing

| | |
|---|---|
| **RAM** | 2 GB runs a handful of projects. 4 GB holds roughly 20–30 light ones, or 8–12 with the REST API on. |
| **Disk** | 20 GB minimum. Images are ~900 MB each, and projects keep data *and* backups locally until you point backups at a bucket. |
| **A single project** | 22–33 MB idle, 150–250 MB for a small app with real traffic. Capped at 512 MB by default. |

---

## When something is wrong

**`docker compose build` stops with a message about `JP_MASTER_KEY`.** Compose reads `.env` for every
command, not just `up`. Create it first.

**Port is already allocated.** Something else has that port. Change `JP_HTTP_PORT` in `.env` and run
`docker compose up -d` again.

**A project fails with "pull access denied".** You have not built the image for that Postgres major.
Run `images/postgres/build.sh`.

**Connection strings show the wrong host.** They use the address you opened the UI on, so open it by
the IP or domain your applications should use. If those differ — say the UI is behind a VPN name —
set `JP_PUBLIC_HOST` in `.env` and `docker compose up -d`. Existing projects pick it up straight away.

**A new project refuses connections: "still being provisioned".** The router refreshes its routing
table every 5 seconds and reads the metadata store read-only, so it lags a few seconds behind a
project turning green. Wait and retry.

**Everything is refused with a 507.** The disk is below the reserved headroom, so anything that
allocates is blocked while deletes still work. Check **Health**, then free space or grow the disk.

**Cannot reach the UI from outside.** In option B, check `JP_BIND_ADDR=0.0.0.0` is in `.env` (and that
you restarted), then the firewall, then the provider's own firewall.

**You forgot the administrator password.** There is no reset link — this instance has no email
channel to send one through. Recover from the host instead:

```bash
docker compose exec control-plane node dist/index.js reset-admin
docker compose restart control-plane
docker compose logs control-plane | grep jp_setup
```

That removes the administrator account and nothing else, so the instance becomes unclaimed and mints
a fresh setup token. Claim it again with the new token and whatever password you want. **Your
projects, their data, their credentials and their backups are untouched, and every database keeps
running throughout** — only the management UI is briefly unclaimed. The reset is written to the audit
log, which outlives the account it describes.

To change a password you still know, use **Instance → Administrator password**. No downtime, and no
need for any of the above.

**Check the Health page first.** It reports the database, Docker, the job worker, storage and disk
separately, and stays up when any of them is down.

For what is protected and what is not, read [SECURITY.md](SECURITY.md).
