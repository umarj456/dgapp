-- 30-day number plans renew on their own unless the customer turns that off.
-- Existing rows keep auto-renew on. Cancel does not drop the number before current_period_end.
ALTER TABLE did_assignments ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT true;
