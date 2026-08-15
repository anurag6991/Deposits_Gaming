-- Invariants that Prisma's schema language cannot express.
--
-- These belong in the database rather than only in application code: a bug, a
-- console session, or a future developer bypassing a service function must not be
-- able to produce a row that violates them.

-- ---------------------------------------------------------------------------
-- Users: role and hierarchy integrity
-- ---------------------------------------------------------------------------

-- A publisher must have a manager; a super admin or manager must not have one.
ALTER TABLE "users"
  ADD CONSTRAINT "users_publisher_requires_manager"
  CHECK ((role = 'PUBLISHER') = (manager_id IS NOT NULL));

-- Emails are stored lowercase so the unique index is genuinely case-insensitive.
-- The application normalises on write; this makes it impossible to get wrong.
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_lowercase"
  CHECK (email = lower(email));

-- manager_id must point at an actual MANAGER. A foreign key alone would happily
-- allow a publisher to be parented to another publisher.
CREATE OR REPLACE FUNCTION assert_manager_id_is_manager() RETURNS trigger AS $$
DECLARE
  parent_role "Role";
BEGIN
  IF NEW.manager_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT role INTO parent_role FROM "users" WHERE id = NEW.manager_id;

  IF parent_role IS DISTINCT FROM 'MANAGER' THEN
    RAISE EXCEPTION 'manager_id must reference a user with role MANAGER (got %)', parent_role
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_manager_id_is_manager"
  BEFORE INSERT OR UPDATE OF manager_id ON "users"
  FOR EACH ROW EXECUTE FUNCTION assert_manager_id_is_manager();

-- A manager who still has publishers cannot have their role changed out from
-- under them, which would silently orphan the hierarchy.
CREATE OR REPLACE FUNCTION assert_manager_has_no_publishers_on_demotion() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'MANAGER' AND NEW.role <> 'MANAGER'
     AND EXISTS (SELECT 1 FROM "users" WHERE manager_id = OLD.id) THEN
    RAISE EXCEPTION 'cannot change role: this manager still has publishers assigned'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_no_demote_with_publishers"
  BEFORE UPDATE OF role ON "users"
  FOR EACH ROW EXECUTE FUNCTION assert_manager_has_no_publishers_on_demotion();

-- ---------------------------------------------------------------------------
-- Test data: duplicate protection
-- ---------------------------------------------------------------------------
-- Scoped per owner and country, so two managers uploading the same public list
-- do not collide with each other. These indexes are what make import duplicate
-- detection reliable rather than best-effort.

CREATE UNIQUE INDEX "test_data_owner_country_email_key"
  ON "test_data" (owner_user_id, country_code, lower(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE UNIQUE INDEX "test_data_owner_country_phone_key"
  ON "test_data" (owner_user_id, country_code, phone)
  WHERE phone IS NOT NULL AND phone <> '';

-- Country codes are uppercase ISO 3166-1 alpha-2 everywhere.
ALTER TABLE "test_data"
  ADD CONSTRAINT "test_data_country_uppercase"
  CHECK (country_code = upper(country_code));

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_country_uppercase"
  CHECK (country_code = upper(country_code));

ALTER TABLE "proxies"
  ADD CONSTRAINT "proxies_country_uppercase"
  CHECK (country_code = upper(country_code));

-- A reserved record must carry who reserved it and when it expires, otherwise the
-- sweeper cannot reclaim it and the row leaks out of the pool permanently.
ALTER TABLE "test_data"
  ADD CONSTRAINT "test_data_reservation_complete"
  CHECK (
    status <> 'RESERVED'
    OR (reserved_by_user_id IS NOT NULL AND reservation_expires_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- Offers: sane targets and intervals
-- ---------------------------------------------------------------------------

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_expiry_after_start"
  CHECK (expiry_date >= start_date);

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_targets_non_negative"
  CHECK (
    monthly_lead_target >= 0
    AND monthly_deposit_target >= 0
    AND monthly_deposit_amount_target >= 0
    AND (lifetime_deposit_amount_target IS NULL OR lifetime_deposit_amount_target >= 0)
  );

ALTER TABLE "offers"
  ADD CONSTRAINT "offers_intervals_valid"
  CHECK (
    lead_interval_seconds >= 0
    AND deposit_interval_seconds >= 0
    AND gameplay_interval_days >= 1
    AND low_data_threshold >= 0
  );

ALTER TABLE "offer_publishers"
  ADD CONSTRAINT "offer_publishers_caps_non_negative"
  CHECK (
    (monthly_lead_cap IS NULL OR monthly_lead_cap >= 0)
    AND (monthly_deposit_cap IS NULL OR monthly_deposit_cap >= 0)
  );

-- ---------------------------------------------------------------------------
-- Money: no negative or zero amounts where they make no sense
-- ---------------------------------------------------------------------------

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_amount_positive" CHECK (amount > 0);

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_balance_non_negative" CHECK (current_balance >= 0);

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_amount_positive" CHECK (amount > 0);

ALTER TABLE "advances"
  ADD CONSTRAINT "advances_amount_positive" CHECK (amount > 0);

ALTER TABLE "balance_entries"
  ADD CONSTRAINT "balance_entries_non_negative"
  CHECK (balance_before >= 0 AND balance_after >= 0);

-- ---------------------------------------------------------------------------
-- Append-only tables
-- ---------------------------------------------------------------------------
-- Enforced by trigger rather than by GRANT, so the guarantee holds regardless of
-- which database role the application connects as.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; rows cannot be updated or deleted', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "balance_entries_append_only"
  BEFORE UPDATE OR DELETE ON "balance_entries"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "gameplay_records_append_only"
  BEFORE UPDATE OR DELETE ON "gameplay_records"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER "deposit_status_changes_append_only"
  BEFORE UPDATE OR DELETE ON "deposit_status_changes"
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ---------------------------------------------------------------------------
-- Month keys
-- ---------------------------------------------------------------------------
-- Written by the application in APP_TIMEZONE. The format is guarded here so a
-- malformed key can never silently break monthly grouping.

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_month_key_format" CHECK (month_key ~ '^\d{4}-\d{2}$');

ALTER TABLE "deposits"
  ADD CONSTRAINT "deposits_month_key_format" CHECK (month_key ~ '^\d{4}-\d{2}$');

ALTER TABLE "withdrawals"
  ADD CONSTRAINT "withdrawals_month_key_format" CHECK (month_key ~ '^\d{4}-\d{2}$');

ALTER TABLE "advances"
  ADD CONSTRAINT "advances_month_key_format" CHECK (month_key ~ '^\d{4}-\d{2}$');

-- ---------------------------------------------------------------------------
-- Performance
-- ---------------------------------------------------------------------------

-- The assignment hot path: available records for a country, own pool first.
-- A partial index keeps it small — USED rows dominate the table over time but
-- are never scanned by this query.
CREATE INDEX "test_data_available_pick"
  ON "test_data" (country_code, owner_user_id, created_at)
  WHERE status = 'AVAILABLE';

-- The overdue-gameplay query, which runs on every publisher dashboard load.
CREATE INDEX "deposits_gameplay_overdue"
  ON "deposits" (next_gameplay_due_at)
  WHERE status = 'ACTIVE' AND next_gameplay_due_at IS NOT NULL;

-- Open task sessions per publisher: small, hot, and checked on every task start.
CREATE INDEX "task_sessions_open"
  ON "task_sessions" (publisher_id, started_at)
  WHERE status = 'OPEN';
