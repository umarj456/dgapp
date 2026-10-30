# DG App (Dialer Giants): Phase 1 scaffold

Calling app in the style of call.com / Numero: anyone signs up, passes KYC, buys a dedicated number from the
DG App DID pool on our SIPNAV switch, and makes/receives calls from the browser (mobile apps in Phase 2).
Approved plan: [`PLAN.md`](PLAN.md).

> Status: **local scaffold only.** Nothing is deployed. No connection has been made to SIPNAV, dialer6, the closer
> server or the DID portal, and there are no real credentials in this repo (only `.env.example` placeholders).

```
dg-app/
├── PLAN.md               approved build plan
├── docker-compose.yml    local dev: postgres + api
├── backend/              Node 20 + TypeScript + Fastify + Postgres
│   ├── migrations/       001 schema, 002 reference data (KYC country rules, IRSF blocklist), 003 dev sample data
│   ├── src/modules/
│   │   ├── auth/         email OTP sign-up/login, phone OTP; OtpProvider interface (console stub in dev)
│   │   ├── kyc/          KYC gate (pure rules + Fastify preHandler), document submission, manual review
│   │   ├── dids/         pool search / buy (wallet or Stripe subscription) / release + cooldown, renewals job
│   │   ├── wallet/       prepaid wallet + ledger, Stripe checkout/setup intents (stub mode), webhook handler
│   │   ├── rating/       longest-prefix rating, 6/6 - 60/60 increments, max duration from balance, reserve/settle
│   │   ├── fraud/        IRSF blocklist, concurrency, velocity, distinct-destination, spend caps, new-account caps
│   │   ├── calls/        edge call control: authorize, inbound DID lookup, end-of-call settle + CDR
│   │   └── sip/          per-device SIP credentials (HA1 only stored)
│   └── test/             unit tests + end-to-end integration test (real Postgres, optional)
├── edge/                 Kamailio + rtpengine WebRTC edge config: DRAFT, see edge/README.md
└── web/                  React + SIP.js client: sign-up, KYC, number picker, wallet, dialer, incoming call
```

## Business rules enforced in code (approved by Umar)
- **KYC before anything**: no DID purchase and no call until email OTP + phone OTP + verified payment method pass.
  ID and/or address are added per DID country (`did_country_requirements`). Enforced server-side twice:
  the `requireKyc` preHandler on `/v1/dids/buy` and inside `authorizeOutbound` for every call.
- **Prepaid only**: wallet has a DB constraint `balance >= 0, held <= balance`. Each call places a hold sized to the
  max duration the available balance allows, the edge hard-stops the call at that duration, and settlement never
  charges more than the hold. Zero balance = call refused (SIP 402).
- **Fraud**: IRSF/premium prefix blocklist (starter list in migration 002, review before launch), max concurrent
  calls, calls per minute/hour, distinct numbers per hour (robocall pattern), 24h spend cap. New accounts (first 7 days):
  1 concurrent call, lower velocity, $10/24h spend, $2 per-call hold, domestic only. Chargebacks suspend the account.
- **Caller ID** = the user's own DID. Client-supplied identity headers are stripped at the edge.

Money is stored as integer micro-USD. All limits are in `src/modules/fraud/fraud.ts` (`DEFAULT_FRAUD_POLICY`) and `.env`.

## Run locally

### Option A: Docker
```bash
docker compose up --build
# API on http://localhost:8080 (OTP codes appear in: docker compose logs -f api)
cd web && npm install && npm run dev      # http://localhost:5173 (proxies /v1 to the API)
```

### Option B: without Docker
```bash
# Postgres 13+ running locally with a dgapp database
cd backend
cp .env.example .env            # edit DATABASE_URL if needed
npm install
MIGRATE_DEV_SEED=true npm run migrate
npm run dev                     # http://localhost:8080
cd ../web && npm install && npm run dev
```

### Tests
```bash
cd backend
npm test                                    # unit tests (no DB needed)
TEST_DATABASE_URL=postgres://dgapp:dgapp@localhost:5432/dgapp_test npm test   # + end-to-end flow (WIPES that DB)
npm run build                               # type-check + compile to dist/
cd ../web && npm run build
```

### Simulating payments in dev (Stripe stub mode)
With `STRIPE_STUB_MODE=true` the webhook accepts unsigned JSON, so you can mark a card verified and top up:
```bash
curl -X POST localhost:8080/v1/stripe/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_dev1","type":"setup_intent.succeeded","data":{"object":{"id":"seti_dev","metadata":{"user_id":"<USER_ID>"}}}}'
curl -X POST localhost:8080/v1/stripe/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_dev2","type":"checkout.session.completed","data":{"object":{"id":"cs_dev","mode":"payment","payment_status":"paid","amount_total":1000,"metadata":{"kind":"topup","user_id":"<USER_ID>"}}}}'
```
Stub mode is refused when `NODE_ENV=production` (as are the console OTP provider and the default internal token).

## API summary
| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/email/start`, `/v1/auth/email/verify` | sign-up/login, email KYC |
| POST | `/v1/me/phone/start`, `/v1/me/phone/verify` | phone KYC |
| GET | `/v1/me` | profile, KYC status, wallet, numbers |
| POST | `/v1/kyc/payment-method/setup` | Stripe SetupIntent (payment-method KYC) |
| POST | `/v1/kyc/documents` | ID / address submission (manual review in Phase 1) |
| GET | `/v1/dids/search`, `/v1/dids/mine` | pool search, my numbers |
| POST | `/v1/dids/buy` | **KYC-gated**; `billing: wallet` (instant) or `stripe` (subscription checkout) |
| POST | `/v1/dids/:assignmentId/release` | number goes to cooldown (30 days) before resale |
| POST | `/v1/wallet/topup`, GET `/v1/wallet/ledger` | Stripe Checkout top-up, history |
| POST | `/v1/sip/credentials` | per-device SIP login for the WebRTC client |
| POST | `/v1/stripe/webhook` | signature-verified (live) / unsigned (stub) |
| GET | `/internal/v1/sip/auth` | edge only: HA1 for digest auth |
| POST | `/internal/v1/calls/authorize`, `/inbound`, `/end` | edge only: call control + CDR |
| POST | `/internal/v1/kyc/review`, `/internal/v1/jobs/maintenance` | ops: KYC review, renewals/cooldown/stale holds (cron) |

`/internal/*` requires `Authorization: Bearer $INTERNAL_API_TOKEN` **and** a source IP in `INTERNAL_ALLOWED_IPS`.

## Open decisions (Umar)
Launch countries · first DID pool size · retail rates + number prices (placeholders in migration 003) · edge/API server ·
Stripe account · OTP/SMS provider for codes · KYC vendor for ID/address (or manual review) · Apple/Google developer
accounts + Firebase (Phase 2) · SIPNAV "DG App" account, tech prefix, attestation.

## DID pool (Phase 1 ops)
Numbers are sold from `did_pool`. Importing is a **DB-only** change; it never calls SIPNAV. Before importing,
the block must already be assigned to the "DG App" SIPNAV account and routed to the edge.
- CSV: `cd backend && npm run seed -- seed/pool.example.csv` (prod image: `npm run seed:prod -- /path/pool.csv`).
  Header: `e164,country,region,number_type,monthly_usd,setup_usd,sipnav_ref`. Re-import updates price/region, never status.
- Internal API (edge/ops network only, bearer `INTERNAL_API_TOKEN` + IP allow-list):
  - `GET  /internal/v1/dids/pool` counts by country/status
  - `POST /internal/v1/dids/pool/import` `{ "numbers": [{ "e164", "country", "region?", "numberType?", "monthlyPriceMicros", "setupPriceMicros?", "sipnavRef?" }] }`
  - `POST /internal/v1/dids/pool/:e164/status` `{ "status": "disabled" | "available" }` (refused for assigned numbers)

## Tests
`cd backend && npm test` runs unit tests. With a throwaway Postgres, `TEST_DATABASE_URL=postgres://... npm test`
also runs the end-to-end flow (sign-up, KYC gate, top-up, buy DID, prepaid call hold/settle, fraud, inbound, pool admin).
**That database is wiped.** CI workflow is staged at `docs/ci.workflow.yml`; copy it to `.github/workflows/ci.yml` from the GitHub UI (the bot token lacks `workflow` scope).
