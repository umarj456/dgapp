# Stub test: sign up, pay, buy a number

Dummy Stripe only. `STRIPE_STUB_MODE=true` and `OTP_PROVIDER=console` make no Stripe or SMS calls. Placeholders `sk_test_placeholder` and `pk_test_placeholder` are not keys. No public DNS.

Start the stack with [`DEPLOY_LOCAL.md`](DEPLOY_LOCAL.md). `NODE_ENV` stays `development`. `MIGRATE_DEV_SEED=true` already loads five fictional 555 numbers. Open the UI at `WEB_ORIGIN`:

| Layout | UI | API | OTP log |
|---|---|---|---|
| Node on the shared host | http://127.0.0.1:4200 | http://127.0.0.1:4100 | the terminal running `node dist/server.js` |
| Docker on a dedicated machine | http://127.0.0.1:5173 | http://127.0.0.1:8080 | `docker compose logs -f api` |

Curl examples below use port **4100**. On Docker, use **8080**.

## 1. Load the fake pool (or the real file later)

`backend/seed/pool.example.csv` is **not real inventory** (NANP 555-01xx, $5.00/month). From `backend/`, with `DATABASE_URL` pointing at this app's database:

```bash
npm run seed -- seed/pool.example.csv
```

Docker image, from the repo root:

```bash
docker compose exec api npm run seed:prod -- seed/pool.example.csv
```

Expected log: `pool import: 8 inserted, 0 updated` the first time, then `0 inserted, 8 updated` if you run it again. Prices refresh. Status of a number that is already assigned does not change. The command never calls SIPNAV. The short local procedure (ports, tunnel, and what cannot work yet) is [`TESTING.md`](TESTING.md).

When the team sends the real block (same columns: `E.164`, `country`, `monthly_price_cents`):

```bash
npm run seed -- /path/to/sipnav-dgapp.csv
```

Optional columns, if that file has them: `region`, `number_type`, `setup_price_cents` or `setup_usd`, `sipnav_ref`. `monthly_usd` is accepted instead of cents. `500` cents is $5.00.

## 2. Clicks

1. Open the UI URL. Type an email such as `you@example.com`. Click **Email me a code**.
2. Read the API log line `[otp:email] login code for you@example.com: 123456`. Type those 6 digits. Click **Continue**.
3. You are on **Numbers**. No card step. Search an area code, pick a row, confirm a phone such as `+15555550199` (code in `[otp:sms]`), then **Pay by card**.
4. **My numbers** shows **Active**, auto-renew on, renew date about 30 days out. Turning auto-renew off keeps the number until that date.
5. Open **Wallet** and **Add calling credit**. That balance is only for calls. The Dialer shows **Calling credit** and a short status such as **Ready** or **Can't connect**.

The card subscription posts `checkout.session.completed` with `kind: did_subscription`. A card on file is not required before you can browse. Calls still do not connect without the edge.

## 3. The same steps as API calls

Email code, from the log:

```bash
curl -sS -X POST http://127.0.0.1:4100/v1/auth/email/start -H 'content-type: application/json' -d '{"email":"you@example.com"}'
curl -sS -X POST http://127.0.0.1:4100/v1/auth/email/verify -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"123456"}'
```

Save `token` from the verify response as `TOKEN`. Phone code, from the log:

```bash
curl -sS -X POST http://127.0.0.1:4100/v1/me/phone/start -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"phone":"+15555550199"}'
curl -sS -X POST http://127.0.0.1:4100/v1/me/phone/verify -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"phone":"+15555550199","code":"123456"}'
```

User id for the webhooks (`GET /v1/me` field `id`):

```bash
curl -sS http://127.0.0.1:4100/v1/me -H "authorization: Bearer $TOKEN"
```

Attach the payment method. The UI does this when you click **Add a card**. By hand:

```bash
curl -sS -X POST http://127.0.0.1:4100/v1/stripe/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_dev_card","type":"setup_intent.succeeded","data":{"object":{"id":"seti_dev","metadata":{"user_id":"<USER_ID>"}}}}'
```

Top up $10 (`amount_total` is cents). The UI does this when you click **Add credit**:

```bash
curl -sS -X POST http://127.0.0.1:4100/v1/stripe/webhook -H 'content-type: application/json' \
  -d '{"id":"evt_dev_topup","type":"checkout.session.completed","data":{"object":{"id":"cs_dev","mode":"payment","payment_status":"paid","amount_total":1000,"metadata":{"kind":"topup","user_id":"<USER_ID>"}}}}'
```

`GET /v1/me` then shows `kyc.canCall: true` and `wallet.balanceUsd` of `10.0000`.

Buy the first US 555 match with the wallet:

```bash
DID=$(curl -sS 'http://127.0.0.1:4100/v1/dids/search?country=US&contains=555' -H "authorization: Bearer $TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
curl -sS -X POST http://127.0.0.1:4100/v1/dids/buy -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"didId\":\"$DID\",\"billing\":\"wallet\"}"
```

The response status is `active`. A second `GET /v1/me` lists that number.
