# Isolated local install

Run Phase 1 on one Linux machine with **no public DNS**, **no live secrets**, and **no changes to other apps**. Nothing in this file installs itself; it is the operator procedure. This repository does not deploy to a remote host.

Two layouts:

| | Dedicated machine | Shared host (example `/opt/dgapp-test`) |
|---|---|---|
| How | Docker Compose | Node 20 + a **new** Postgres, loopback only |
| API | `127.0.0.1:8080` | `127.0.0.1:4100` |
| Web | `127.0.0.1:5173` | `127.0.0.1:4200` |
| Postgres | Compose, host `127.0.0.1:5432` | Own data dir, `127.0.0.1:5433` |

On the surveyed app server (`SERVER_138.201.138.161_survey.md`) Docker is not installed, `8080` is the DID portal, `5432` is live Postgres, and UDP `5060` is Asterisk. Use the shared-host path there. Do not install Docker, do not edit nginx, firewalld, or root PM2, and do not create a role in the live Postgres.

Sample DIDs from `MIGRATE_DEV_SEED` are fictional `555-01xx` numbers. They are not a SIPNAV inventory. Browser calling stays disconnected until the edge and SIPNAV exist (`GO_LIVE_CHECKLIST.md`).

## Shared host (`/opt/dgapp-test`)

Run as the dedicated user (`dgapptest` on the surveyed host), not root. The directory is the only install root.

```bash
sudo install -d -o dgapptest -g dgapptest -m 750 /opt/dgapp-test
sudo -u dgapptest -H git clone https://github.com/umarj456/dgapp.git /opt/dgapp-test/app
```

### Postgres (own cluster, port 5433)

Use the Postgres binaries already on the machine (`psql --version`, 13+). `initdb` creates a second data directory. It does not touch the live cluster.

```bash
sudo -u dgapptest -H bash
umask 077
printf '%s\n' 'replace-this-local-password' > /opt/dgapp-test/pg.pw
initdb -D /opt/dgapp-test/pgdata --username=dgapp --pwfile=/opt/dgapp-test/pg.pw --auth-local=peer --auth-host=scram-sha-256
```

In `/opt/dgapp-test/pgdata/postgresql.conf` set `listen_addresses = '127.0.0.1'`, `port = 5433`, and `unix_socket_directories = '/opt/dgapp-test/pgdata'` so the cluster does not try to create a socket in the system directory `/var/run/postgresql`. In `pg_hba.conf` allow only loopback:

```
host  all  dgapp  127.0.0.1/32  scram-sha-256
```

`all` is the database column so the bootstrap superuser can create the `dgapp` database and then use it. Replace any default `host all all` lines so TCP from other addresses is not accepted. The role is still only `dgapp`, and only from loopback.

```bash
pg_ctl -D /opt/dgapp-test/pgdata -l /opt/dgapp-test/postgres.log start
export PGPASSWORD="$(cat /opt/dgapp-test/pg.pw)"
psql -h 127.0.0.1 -p 5433 -U dgapp -d postgres -c 'SELECT version();'
psql -h 127.0.0.1 -p 5433 -U dgapp -d postgres -c 'CREATE DATABASE dgapp OWNER dgapp;'
```

Put the same password in `DATABASE_URL`. The value `dgapp` in `.env.example` is a placeholder. Percent-encode `@`, `:`, `/`, `#`, and spaces in that URL.

### API

```bash
cd /opt/dgapp-test/app/backend
cp .env.example .env
# edit DATABASE_URL password; leave HOST=127.0.0.1 PORT=4100 NODE_ENV=development
npm ci
npm run migrate
npm run build
node dist/server.js
```

`NODE_ENV` stays `development` so console OTP and the Stripe stub can start. `production` refuses both. OTP lines look like:

```
[otp:email] login code for you@example.com: 123456
[otp:sms] verify_phone code for +15551234567: 123456
```

Health:

```bash
curl -fsS http://127.0.0.1:4100/healthz
# {"ok":true}
```

### Web

```bash
cd /opt/dgapp-test/app/web
cp .env.example .env
npm ci
npm run dev
```

Vite listens on `127.0.0.1:4200` and proxies `/v1` to `127.0.0.1:4100`. From a laptop:

```bash
ssh -L 4200:127.0.0.1:4200 <user>@<host>
```

Open `http://127.0.0.1:4200`. That URL must equal `WEB_ORIGIN`. Sign-up reads the email code from the API log. Phone verification reads the SMS code from the same log. "Add a card" and "Add credit" complete through the Stripe stub (no Stripe network call). `pk_test_placeholder` / `sk_test_placeholder` / `whsec_placeholder` are not accounts.

Leave the two processes under `dgapptest` (a terminal or a **user** service). Do not `pm2 start` as root.

### Private IP, still no public DNS

Only on a lab machine with no other apps on these ports. Set `HOST=0.0.0.0` is **not** required: keep the API on `127.0.0.1` and let Vite proxy. Set `VITE_HOST=0.0.0.0`, open port `4200` on the private interface only, and set `WEB_ORIGIN=http://<private-ip>:4200`. Do not add a public DNS name and do not open the port on a public interface.

## Dedicated machine (Docker)

Docker is for a machine where Compose will not share a network stack with live apps. Skip this on the surveyed server.

```bash
git clone https://github.com/umarj456/dgapp.git /opt/dgapp-test/app
cd /opt/dgapp-test/app
cp .env.example .env
# If 5432 or 8080 is taken: set POSTGRES_PORT and API_PORT in .env, and set WEB_ORIGIN to match.
docker compose up --build
curl -fsS http://127.0.0.1:8080/healthz
docker compose ps          # postgres, api, and web should be healthy
docker compose logs -f api # console OTP
```

UI: `http://127.0.0.1:5173`. Compose publishes `127.0.0.1` only. Postgres and the API stay on loopback; the browser talks to Vite, which proxies `/v1` to the API container. To reach the UI from another machine on a private network, set `WEB_BIND` to that private IP (or `0.0.0.0` on a lab VM) and set `WEB_ORIGIN` to the same origin. Do not point `WEB_BIND` at a public address.

`GET /healthz` is also the image `HEALTHCHECK`. A database outage fails the check.

Stop with `docker compose down` in this directory. Volumes are named `dgapp_pgdata` and `dgapp_webmodules` (or `${COMPOSE_PROJECT_NAME}_*`). Removing them does not affect other Compose projects.

## Manual Stripe stub (optional)

The UI already posts these while stub mode is on. To do it by hand, replace `<USER_ID>` with the id from `GET /v1/me`:

```bash
curl -X POST http://127.0.0.1:4100/v1/stripe/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_dev1","type":"setup_intent.succeeded","data":{"object":{"id":"seti_dev","metadata":{"user_id":"<USER_ID>"}}}}'
curl -X POST http://127.0.0.1:4100/v1/stripe/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_dev2","type":"checkout.session.completed","data":{"object":{"id":"cs_dev","mode":"payment","payment_status":"paid","amount_total":1000,"metadata":{"kind":"topup","user_id":"<USER_ID>"}}}}'
```

Use port `8080` on the Docker layout.
