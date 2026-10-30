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
2. On Verify, enter a phone such as `+15555550199`. **Text me a code.** Read `[otp:sms] verify_phone code for +15555550199: 123456`. **Verify.**
3. **Add a card.** The stub posts `setup_intent.succeeded`. The screen says `Dev stub recorded a verified payment method.` and **Payment method verified: passed.**
4. Open **Wallet**. Leave **$10**. **Add credit.** The stub posts `checkout.session.completed` (`kind: topup`, `amount_total` 1000 cents). Balance reads `Balance: $10.0000`.
5. Open **Numbers**. Country **United States**, digits `555`, **Search**. **Pay from balance** on a `$5.0000/mo` row. It appears under **My numbers** as `active`, and the balance drops by $5.
6. Optional card purchase: **Subscribe by card** on another row. The stub posts `checkout.session.completed` with `kind: did_subscription` and the message ends with `(dev stub card)`. No Stripe page opens.

No card number is collected. The same webhook bodies, sent by hand, are in `TEST_FLOW.md`.

## What will not work yet

- **Dialer audio, inbound ringing, and registration.** After verification the Dialer tab tries `wss://sip.dialergiants.example:8443/ws` and shows `error`. There is no Kamailio edge and no SIPNAV route. A bought 555 number is a database row, not a carrier number.
- **Real email or SMS.** Codes exist only in the API log.
- **Real charges, refunds, or Stripe webhooks from Stripe.** The stub accepts unsigned JSON and is refused when `NODE_ENV=production`.
- **Calling another person, caller ID on the PSTN, and porting.** Those wait on the SIPNAV DG App account, a real DID file, and the edge host in `GO_LIVE_CHECKLIST.md`.
