-- DG App Phase 1 schema. Money is stored as integer micro-USD (1 USD = 1,000,000) to avoid float rounding.
-- Requires PostgreSQL 13+ (gen_random_uuid is built in).

CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,
  phone_e164       TEXT UNIQUE,
  display_name     TEXT,
  country          CHAR(2),                     -- self-declared residence
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  sip_aor          TEXT NOT NULL UNIQUE,        -- user part of the SIP address-of-record on the edge
  stripe_customer_id TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time codes for email / phone verification and login. Only a hash of the code is stored.
CREATE TABLE otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     TEXT NOT NULL CHECK (channel IN ('email','sms')),
  destination TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('login','verify_email','verify_phone')),
  code_hash   TEXT NOT NULL,
  attempts    INT  NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_dest_idx ON otp_codes (destination, purpose, created_at DESC);

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- KYC evidence. One row per check type; latest row per (user, check_type) wins.
CREATE TABLE kyc_checks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  check_type  TEXT NOT NULL CHECK (check_type IN ('email','phone','payment_method','id_document','address')),
  status      TEXT NOT NULL CHECK (status IN ('pending','passed','failed')),
  provider    TEXT,                 -- e.g. 'otp', 'stripe', 'manual', future KYC vendor
  reference   TEXT,                 -- provider id (Stripe setup intent, KYC vendor case id ...)
  country     CHAR(2),              -- for address / id checks: country the evidence covers
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kyc_checks_user_idx ON kyc_checks (user_id, check_type, created_at DESC);

-- Per-country DID rules (which KYC extras the regulator / carrier requires).
CREATE TABLE did_country_requirements (
  country          CHAR(2) PRIMARY KEY,
  requires_id      BOOLEAN NOT NULL DEFAULT false,
  requires_address BOOLEAN NOT NULL DEFAULT false,
  address_must_be_local BOOLEAN NOT NULL DEFAULT false,
  notes            TEXT
);

-- DIDs pre-assigned to the "DG App" account on SIPNAV. The app sells from this pool.
CREATE TABLE did_pool (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  e164            TEXT NOT NULL UNIQUE,        -- digits only, no '+', e.g. 12125550100
  country         CHAR(2) NOT NULL,
  region          TEXT,                        -- state / area code label
  number_type     TEXT NOT NULL DEFAULT 'local' CHECK (number_type IN ('local','tollfree','mobile','national')),
  capabilities    TEXT[] NOT NULL DEFAULT ARRAY['voice'],
  monthly_price_micros BIGINT NOT NULL,        -- retail subscription price
  setup_price_micros   BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','assigned','cooldown','disabled')),
  cooldown_until  TIMESTAMPTZ,                 -- released numbers rest before resale
  sipnav_ref      TEXT,                        -- reference on SIPNAV, informational only
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX did_pool_search_idx ON did_pool (status, country, region);

CREATE TABLE did_assignments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  did_id             UUID NOT NULL REFERENCES did_pool(id),
  user_id            UUID NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','active','past_due','released')),
  billing_source     TEXT NOT NULL DEFAULT 'wallet' CHECK (billing_source IN ('wallet','stripe','iap')),
  stripe_subscription_id TEXT UNIQUE,
  current_period_end TIMESTAMPTZ,
  is_primary_cid     BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at        TIMESTAMPTZ
);
-- a DID can only have one live assignment
CREATE UNIQUE INDEX did_assignments_live_uq ON did_assignments (did_id) WHERE status <> 'released';
CREATE INDEX did_assignments_user_idx ON did_assignments (user_id, status);

-- Prepaid wallet. balance = settled money; held = sum of open call reservations. available = balance - held.
CREATE TABLE wallets (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency        CHAR(3) NOT NULL DEFAULT 'USD',
  balance_micros  BIGINT NOT NULL DEFAULT 0,
  held_micros     BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_prepaid_only CHECK (balance_micros >= 0 AND held_micros >= 0 AND held_micros <= balance_micros)
);

CREATE TABLE ledger_entries (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('topup','call','did_subscription','did_setup','refund','adjustment')),
  amount_micros BIGINT NOT NULL,              -- +credit / -debit
  balance_after BIGINT NOT NULL,
  ref_type      TEXT,
  ref_id        TEXT,
  idempotency_key TEXT UNIQUE,                -- e.g. stripe event id, call auth id
  memo          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON ledger_entries (user_id, created_at DESC);

CREATE TABLE stripe_events (
  id           TEXT PRIMARY KEY,               -- Stripe event id; processed once
  type         TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retail rate deck (SIPNAV cost + markup). Longest prefix wins.
CREATE TABLE rate_deck (
  id                 SERIAL PRIMARY KEY,
  prefix             TEXT NOT NULL,            -- E.164 digits, e.g. '1', '1212', '44', '447'
  description        TEXT,
  rate_per_min_micros BIGINT NOT NULL CHECK (rate_per_min_micros >= 0),
  cost_per_min_micros BIGINT,                  -- wholesale SIPNAV cost, for margin reports
  connect_fee_micros BIGINT NOT NULL DEFAULT 0,
  initial_increment  INT NOT NULL DEFAULT 60 CHECK (initial_increment > 0),
  billing_increment  INT NOT NULL DEFAULT 60 CHECK (billing_increment > 0),
  effective_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to       TIMESTAMPTZ,
  UNIQUE (prefix, effective_from)
);
CREATE INDEX rate_deck_prefix_idx ON rate_deck (prefix);

-- High-risk / IRSF destinations. Longest prefix match; action block or require_review.
CREATE TABLE destination_blocklist (
  id         SERIAL PRIMARY KEY,
  prefix     TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL,
  action     TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block','established_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- SIP device credentials for the edge. Only HA1 (md5(user:realm:pass)) is stored.
CREATE TABLE sip_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_username TEXT NOT NULL UNIQUE,
  ha1          TEXT NOT NULL,
  device_label TEXT,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-call pre-authorization (hold on the wallet).
CREATE TABLE call_authorizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  sip_call_id      TEXT NOT NULL UNIQUE,
  direction        TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  caller_id        TEXT,
  destination      TEXT NOT NULL,
  rate_id          INT REFERENCES rate_deck(id),
  rate_snapshot    JSONB,
  max_duration_sec INT NOT NULL,
  reserved_micros  BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','expired','cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at       TIMESTAMPTZ
);
CREATE INDEX call_auth_user_open_idx ON call_authorizations (user_id) WHERE status = 'open';
CREATE INDEX call_auth_user_time_idx ON call_authorizations (user_id, created_at DESC);

CREATE TABLE cdrs (
  id              BIGSERIAL PRIMARY KEY,
  authorization_id UUID REFERENCES call_authorizations(id),
  user_id         UUID REFERENCES users(id),
  sip_call_id     TEXT NOT NULL UNIQUE,
  direction       TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  caller_id       TEXT,
  destination     TEXT NOT NULL,
  start_time      TIMESTAMPTZ,
  answer_time     TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  billsec         INT NOT NULL DEFAULT 0,
  billable_sec    INT NOT NULL DEFAULT 0,
  sip_code        INT,
  hangup_cause    TEXT,
  charged_micros  BIGINT NOT NULL DEFAULT 0,
  rate_per_min_micros BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cdrs_user_idx ON cdrs (user_id, created_at DESC);
