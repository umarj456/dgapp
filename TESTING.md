# Local test without SIPNAV

Signup, dummy Stripe, and buying a number from `did_pool`. No live Stripe keys, no SIPNAV API, and no audio. Install the process with [`DEPLOY_LOCAL.md`](DEPLOY_LOCAL.md). Exact curl bodies are in [`TEST_FLOW.md`](TEST_FLOW.md).

`NODE_ENV=development`, `OTP_PROVIDER=console`, and `STRIPE_STUB_MODE=true` (the defaults in `backend/.env.example`). Placeholders `sk_test_placeholder`, `whsec_placeholder`, and `pk_test_placeholder` are not accounts. Production refuses the console OTP provider and the stub.

## Ports and tunnel

| Layout | Open this URL (`WEB_ORIGIN`) | API | Where the OTP is printed |
|---|---|---|---|
| Node on the shared host | http://127.0.0.1:4200 | http://127.0.0.1:4100 | the terminal running `node dist/server.js` |
| Docker on a dedicated machine | http://127.0.0.1:5173 | http://127.0.0.1:8080 | `docker compose logs -f api` |

The shared host binds loopback only. From a laptop:

```bash
ssh -L 4200:127.0.0.1:4200 <user>@<host>
```

Then open `http://127.0.0.1:4200`. That host must match `WEB_ORIGIN`. Check the API with `curl -fsS http://127.0.0.1:4100/healthz` (`{"ok":true}`).

## Pool (database only)

`MIGRATE_DEV_SEED=true` already inserts five fictional 555 numbers. To load the eight-number sample, or later the real SIPNAV file:

```bash
cd backend
npm run seed -- seed/pool.example.csv
# later: npm run seed -- /path/to/sipnav-dgapp.csv
```

`backend/seed/pool.example.csv` is labeled **not real inventory**. Header: `E.164,country,monthly_price_cents` (`500` = $5.00). Optional `region`. The first run prints `pool import: 8 inserted, 0 updated`. A repeat updates price and leaves status alone. Nothing in this command contacts SIPNAV.

Docker: `docker compose exec api npm run seed:prod -- seed/pool.example.csv`.

## Clicks

1. **Email me a code.** Read `[otp:email] login code for <you>: 123456` in the API log. Enter it. **Continue.**
2. You land on **Numbers**. Search area code `212`, pick a row, and confirm your phone (`+15555550199`). The code is the API log line `[otp:sms] verify_phone code for +15555550199: 123456`. **Confirm**, then **Pay by card**.
3. The number shows under **My numbers** as **Active**, auto-renew on, for 30 days. Calling credit is not charged for the number.
4. Open **Wallet**. Leave **$10**. **Add calling credit.** The line reads `Calling credit 10.00` and keeps updating while that page is open.

No card number is collected. The same webhook bodies, sent by hand, are in `TEST_FLOW.md`.

## What will not work yet

- **Dialer audio, inbound ringing, and registration.** The Dialer shows **Can't connect**. There is no Kamailio edge and no SIPNAV route in this lab. A bought 555 number is a database row, not a carrier number. The screen does not show SIP codes or socket errors.
- **Real email or SMS.** Codes exist only in the API log.
- **Real charges, refunds, or Stripe webhooks from Stripe.** The stub accepts unsigned JSON and is refused when `NODE_ENV=production`.
- **Calling another person, caller ID on the PSTN, and porting.** Those wait on the SIPNAV DG App account, a real DID file, and the edge host in `GO_LIVE_CHECKLIST.md`.
