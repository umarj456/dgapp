# DG App go-live checklist

Phase 1 can run on an isolated host (loopback or a private IP, console OTP, Stripe stub, fictional DID seed). Public calling cannot. This file is the split between what the repo already contains and what still has to come from Umar or ops. No live secrets belong in git.

Last aligned with the scaffold: isolated-path docs and health checks (see `DEPLOY_LOCAL.md`).

## Ready in this repo

- [x] API (Fastify), web (React + SIP.js), Postgres migrations including PG 13+.
- [x] KYC gate, prepaid wallet, fraud limits, DID pool admin, call authorize/settle for the edge.
- [x] Console OTP (`OTP_PROVIDER=console`). Codes are log lines `[otp:email]` and `[otp:sms]`. Refused when `NODE_ENV=production`.
- [x] Stripe stub (`STRIPE_STUB_MODE=true`) with placeholders `sk_test_placeholder`, `whsec_placeholder`, `pk_test_placeholder`. Unsigned webhook; the web UI applies it in dev. Refused when `NODE_ENV=production`.
- [x] `GET /healthz` (database ping). Compose health checks for Postgres, API, and web. API image `HEALTHCHECK`.
- [x] Docker Compose for a dedicated machine: loopback publishes, dev seed, console OTP, Stripe stub. See `.env.example`.
- [x] Node + dedicated Postgres procedure for `/opt/dgapp-test` that stays off live ports `8080`, `5432`, and UDP `5060`. See `DEPLOY_LOCAL.md`.
- [x] Dev DID seed (`555-01xx`) and placeholder rates, loaded only when `MIGRATE_DEV_SEED=true`.

## Ops to start the isolated folder (Umar)

Not done by this repo. Do not install Docker on `138.201.138.161`. Do not change nginx, firewalld, root PM2, or the live Postgres.

- [ ] Confirm the `dgapptest` user and `/opt/dgapp-test` are still the install root.
- [ ] Clone the app under that directory and pick a database password (replace the `dgapp` placeholder).
- [ ] Start a **new** Postgres data directory on `127.0.0.1:5433` (`initdb` as that user). Leave the live cluster on `5432` alone.
- [ ] `npm ci`, migrate, and run the API on `127.0.0.1:4100` and the web UI on `127.0.0.1:4200` as `dgapptest`.
- [ ] `curl -fsS http://127.0.0.1:4100/healthz` returns `{"ok":true}`.
- [ ] Sign up through an SSH tunnel, read the OTP from the API log, and confirm the Stripe stub marks the payment method and a top-up.
- [ ] Keep `NODE_ENV=development` until real OTP delivery and real Stripe keys exist.

A private-IP lab (still no public DNS) is the same build with `WEB_ORIGIN` set to `http://<private-ip>:<port>`. The Kamailio lab install is [`EDGE_DEPLOY.md`](EDGE_DEPLOY.md). It is not started until Umar says go.

## Still required before real traffic (Umar)

- [ ] SIPNAV wholesale account named for DG App: one IP-authenticated endpoint, tech prefix (replace placeholder `05436#`), attestation, and the carriers to use.
- [ ] A real DID block assigned to that account and routed to the edge. Import with `cd backend && npm run seed -- /path/to/sipnav-dgapp.csv` (header `E.164,country,monthly_price_cents`). The `555` sample is not inventory. Local stub test: `TESTING.md`.
- [ ] Approved retail rates and monthly number prices (migration `003` values are placeholders).
- [ ] Launch countries and the first pool size.
- [ ] Stripe, out of band into the host `.env` only: `STRIPE_SECRET_KEY` (secret `sk_live_` or restricted `rk_live_`), `STRIPE_PUBLISHABLE_KEY` (`pk_live_`), and `STRIPE_WEBHOOK_SECRET` (the `whsec_` signing secret). Webhook endpoint is `POST /v1/stripe/webhook`. Set `STRIPE_STUB_MODE=false`. Do not commit the values.
- [ ] PayPal, out of band into the same file: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_MODE=live`. A PayPal capture credits the prepaid wallet or activates a reserved number.
- [ ] Real DID import: `MIGRATE_DEV_SEED=false`, then `npm run seed -- /path/to/sipnav-dgapp.csv`. The 555 sample is not inventory.
- [ ] Real OTP. `smtp` and `twilio` are named in config and are not implemented. Console OTP cannot be the production provider.
- [ ] KYC vendor, or named staff for manual ID/address review (`POST /internal/v1/kyc/review`).
- [ ] DNS when ready: `app.` and `sip.` names, plus TLS certificates. Isolated mode does not need them.
- [ ] LEAD confirms the SIPNAV DG App account id, signalling IP (lab default `88.151.129.15`), and tech prefix (placeholder `"05436#"` until then). Developer then installs the edge on 138 with [`EDGE_DEPLOY.md`](EDGE_DEPLOY.md): UDP `15060` and WSS `18443`, not Asterisk's `5060` or the DID portal. Configs are in the repo and are not installed yet.
- [ ] Firewall on 138: add firewalld rich rules from `EDGE_DEPLOY.md` (SIP only from the SIPNAV IP, WSS, RTP `35000-35999`). Do not load `edge/firewall.nft.example` on that host. `INTERNAL_API_TOKEN` must match Kamailio `API_TOKEN` and must not be the dev default once `NODE_ENV=production`.
- [ ] Where the API and Postgres will live in production (the isolated folder is a smoke host, not the public edge).

Phase 2, not this checklist: Apple/Google developer accounts, Firebase, and mobile push.

## Out of scope for the code change that added this file

- No SSH, no deploy, no firewall or DNS edits, no Stripe or SIPNAV calls.
- No live credentials committed.
