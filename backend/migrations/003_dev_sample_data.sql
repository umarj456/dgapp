-- DEV ONLY sample data (skipped unless MIGRATE_DEV_SEED=true). Fake numbers from the 555-01xx fictional range.
-- Rates are PLACEHOLDERS, not approved retail pricing.
INSERT INTO rate_deck (prefix, description, rate_per_min_micros, cost_per_min_micros, initial_increment, billing_increment) VALUES
  ('1',    'US/Canada',          10000, 3000, 6, 6),
  ('1800', 'US toll-free',       10000, 2000, 6, 6),
  ('44',   'United Kingdom',     20000, 8000, 60, 60),
  ('447',  'United Kingdom mob', 50000, 20000, 60, 60),
  ('92',   'Pakistan',           80000, 40000, 60, 60),
  ('923',  'Pakistan mobile',    90000, 45000, 60, 60)
ON CONFLICT DO NOTHING;

INSERT INTO did_pool (e164, country, region, number_type, monthly_price_micros, setup_price_micros) VALUES
  ('12125550101','US','NY-212','local',5000000,0),
  ('12125550102','US','NY-212','local',5000000,0),
  ('13105550103','US','CA-310','local',5000000,0),
  ('13105550104','US','CA-310','local',5000000,0),
  ('17135550105','US','TX-713','local',5000000,0)
ON CONFLICT (e164) DO NOTHING;
