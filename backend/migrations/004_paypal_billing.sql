-- Allow a DID to be paid with PayPal (one-time capture) as well as wallet, Stripe, or a future IAP.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
   WHERE con.conrelid = 'did_assignments'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%billing_source%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE did_assignments DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE did_assignments ADD CONSTRAINT did_assignments_billing_source_check
  CHECK (billing_source IN ('wallet', 'stripe', 'iap', 'paypal'));
