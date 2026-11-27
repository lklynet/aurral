ALTER TABLE connect_entitlements ADD COLUMN polar_customer_id TEXT;
ALTER TABLE connect_entitlements ADD COLUMN polar_subscription_id TEXT;
ALTER TABLE connect_entitlements ADD COLUMN polar_subscription_created_at INTEGER;
ALTER TABLE connect_entitlements ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connect_entitlements ADD COLUMN billing_interval TEXT;
ALTER TABLE connect_entitlements ADD COLUMN polar_event_at INTEGER;

CREATE INDEX connect_entitlements_polar_sub_idx
  ON connect_entitlements (polar_subscription_id)
  WHERE polar_subscription_id IS NOT NULL;

CREATE INDEX connect_entitlements_polar_customer_idx
  ON connect_entitlements (polar_customer_id)
  WHERE polar_customer_id IS NOT NULL;
