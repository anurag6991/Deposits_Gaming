#!/usr/bin/env node
/**
 * Applies every migration to a throwaway in-memory Postgres (PGlite) and then
 * exercises the invariants they are supposed to enforce.
 *
 * This exists because the development machine is Windows on ARM64, where no
 * native PostgreSQL build is available. Without it the migration SQL would ship
 * having never executed. PGlite is real PostgreSQL compiled to WASM, so the
 * DDL, the plpgsql triggers, and the CHECK constraints all run for real.
 *
 * Run: node ops/scripts/verify-migrations.mjs
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'apps/api/prisma/migrations';

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

function bad(name, detail) {
  failed += 1;
  console.log(`  FAIL  ${name}\n        ${detail}`);
}

/** Asserts that a statement is rejected by the database. */
async function mustReject(db, name, sql, expectFragment) {
  try {
    await db.exec(sql);
    bad(name, 'statement was accepted but should have been rejected');
  } catch (err) {
    const msg = String(err.message ?? err);
    if (expectFragment && !msg.toLowerCase().includes(expectFragment.toLowerCase())) {
      bad(name, `rejected, but for the wrong reason: ${msg}`);
    } else {
      ok(name);
    }
  }
}

async function mustAccept(db, name, sql) {
  try {
    await db.exec(sql);
    ok(name);
  } catch (err) {
    bad(name, String(err.message ?? err));
  }
}

const db = new PGlite();
await db.waitReady;

// ---------------------------------------------------------------------------
// Apply migrations in order
// ---------------------------------------------------------------------------
console.log('\nApplying migrations');
const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const dir of dirs) {
  const sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
  try {
    await db.exec(sql);
    console.log(`  OK    ${dir}`);
  } catch (err) {
    console.error(`  ERROR ${dir}\n        ${err.message ?? err}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SA = '11111111-1111-1111-1111-111111111111';
const MGR = '22222222-2222-2222-2222-222222222222';
const PUB = '33333333-3333-3333-3333-333333333333';

await db.exec(`
  INSERT INTO users (id, email, password_hash, full_name, role, updated_at)
  VALUES ('${SA}', 'admin@example.com', 'x', 'Admin', 'SUPER_ADMIN', now());
  INSERT INTO users (id, email, password_hash, full_name, role, created_by_id, updated_at)
  VALUES ('${MGR}', 'mgr@example.com', 'x', 'Manager', 'MANAGER', '${SA}', now());
  INSERT INTO users (id, email, password_hash, full_name, role, manager_id, created_by_id, updated_at)
  VALUES ('${PUB}', 'pub@example.com', 'x', 'Publisher', 'PUBLISHER', '${MGR}', '${MGR}', now());
`);

console.log('\nHierarchy integrity');

await mustReject(
  db,
  'publisher without a manager is rejected',
  `INSERT INTO users (id, email, password_hash, full_name, role, updated_at)
   VALUES (gen_random_uuid(), 'orphan@example.com', 'x', 'Orphan', 'PUBLISHER', now());`,
  'users_publisher_requires_manager',
);

await mustReject(
  db,
  'manager carrying a manager_id is rejected',
  `INSERT INTO users (id, email, password_hash, full_name, role, manager_id, updated_at)
   VALUES (gen_random_uuid(), 'mgr2@example.com', 'x', 'M2', 'MANAGER', '${MGR}', now());`,
  'users_publisher_requires_manager',
);

await mustReject(
  db,
  'publisher parented to another publisher is rejected',
  `INSERT INTO users (id, email, password_hash, full_name, role, manager_id, updated_at)
   VALUES (gen_random_uuid(), 'p2@example.com', 'x', 'P2', 'PUBLISHER', '${PUB}', now());`,
  'MANAGER',
);

await mustReject(
  db,
  'uppercase email is rejected',
  `INSERT INTO users (id, email, password_hash, full_name, role, updated_at)
   VALUES (gen_random_uuid(), 'Mixed@Example.com', 'x', 'X', 'SUPER_ADMIN', now());`,
  'users_email_lowercase',
);

await mustReject(
  db,
  'demoting a manager who still has publishers is rejected',
  `UPDATE users SET role = 'PUBLISHER' WHERE id = '${MGR}';`,
  'still has publishers',
);

console.log('\nAppend-only tables');

await db.exec(`
  INSERT INTO audit_logs (id, actor_user_id, actor_role, action, entity_type, entity_id)
  VALUES (gen_random_uuid(), '${SA}', 'SUPER_ADMIN', 'test.action', 'user', '${SA}');
`);

await mustReject(
  db,
  'audit_logs cannot be updated',
  `UPDATE audit_logs SET action = 'tampered';`,
  'append-only',
);

await mustReject(db, 'audit_logs cannot be deleted', `DELETE FROM audit_logs;`, 'append-only');

console.log('\nTest data duplicate protection');

await db.exec(`
  INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, email, phone, updated_at)
  VALUES (gen_random_uuid(), '${SA}', 'US', 'Jane', 'Doe', 'jane@example.com', '5550001', now());
`);

await mustReject(
  db,
  'same owner + country + email is rejected',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, email, updated_at)
   VALUES (gen_random_uuid(), '${SA}', 'US', 'Jane', 'Dupe', 'jane@example.com', now());`,
  'test_data_owner_country_email_key',
);

await mustReject(
  db,
  'email duplicate detection is case-insensitive',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, email, updated_at)
   VALUES (gen_random_uuid(), '${SA}', 'US', 'Jane', 'Dupe', 'JANE@EXAMPLE.COM', now());`,
  'test_data_owner_country_email_key',
);

await mustAccept(
  db,
  'a different owner may hold the same email',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, email, updated_at)
   VALUES (gen_random_uuid(), '${MGR}', 'US', 'Jane', 'Doe', 'jane@example.com', now());`,
);

await mustAccept(
  db,
  'a different country may hold the same email',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, email, updated_at)
   VALUES (gen_random_uuid(), '${SA}', 'GB', 'Jane', 'Doe', 'jane@example.com', now());`,
);

await mustAccept(
  db,
  'multiple records with NULL email are allowed',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, updated_at)
   VALUES (gen_random_uuid(), '${SA}', 'US', 'No', 'Email1', now()),
          (gen_random_uuid(), '${SA}', 'US', 'No', 'Email2', now());`,
);

await mustReject(
  db,
  'lowercase country code is rejected',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, updated_at)
   VALUES (gen_random_uuid(), '${SA}', 'us', 'Bad', 'Country', now());`,
  'test_data_country_uppercase',
);

await mustReject(
  db,
  'RESERVED without reservation metadata is rejected',
  `INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, status, updated_at)
   VALUES (gen_random_uuid(), '${SA}', 'US', 'Bad', 'Reservation', 'RESERVED', now());`,
  'test_data_reservation_complete',
);

console.log('\nOffer validity');

const OFFER = '44444444-4444-4444-4444-444444444444';
await db.exec(`
  INSERT INTO offers (id, name, brand, country_code, url, owner_user_id, created_by_id,
                      start_date, expiry_date, monthly_lead_target, monthly_deposit_target,
                      monthly_deposit_amount_target, lead_interval_seconds,
                      deposit_interval_seconds, gameplay_interval_days, updated_at)
  VALUES ('${OFFER}', 'US Test', 'BrandA', 'US', 'https://example.com', '${SA}', '${SA}',
          DATE '2026-08-01', DATE '2026-10-30', 100, 50, 10000.00, 300, 7200, 3, now());
`);

await mustReject(
  db,
  'expiry before start is rejected',
  `INSERT INTO offers (id, name, brand, country_code, url, owner_user_id, created_by_id,
                       start_date, expiry_date, monthly_lead_target, monthly_deposit_target,
                       monthly_deposit_amount_target, lead_interval_seconds,
                       deposit_interval_seconds, gameplay_interval_days, updated_at)
   VALUES (gen_random_uuid(), 'Bad', 'B', 'US', 'https://x.com', '${SA}', '${SA}',
           DATE '2026-08-01', DATE '2026-07-01', 1, 1, 1, 1, 1, 1, now());`,
  'offers_expiry_after_start',
);

await mustReject(
  db,
  'zero gameplay interval is rejected',
  `INSERT INTO offers (id, name, brand, country_code, url, owner_user_id, created_by_id,
                       start_date, expiry_date, monthly_lead_target, monthly_deposit_target,
                       monthly_deposit_amount_target, lead_interval_seconds,
                       deposit_interval_seconds, gameplay_interval_days, updated_at)
   VALUES (gen_random_uuid(), 'Bad', 'B', 'US', 'https://x.com', '${SA}', '${SA}',
           DATE '2026-08-01', DATE '2026-09-01', 1, 1, 1, 1, 1, 0, now());`,
  'offers_intervals_valid',
);

await mustReject(
  db,
  'negative lead target is rejected',
  `INSERT INTO offers (id, name, brand, country_code, url, owner_user_id, created_by_id,
                       start_date, expiry_date, monthly_lead_target, monthly_deposit_target,
                       monthly_deposit_amount_target, lead_interval_seconds,
                       deposit_interval_seconds, gameplay_interval_days, updated_at)
   VALUES (gen_random_uuid(), 'Bad', 'B', 'US', 'https://x.com', '${SA}', '${SA}',
           DATE '2026-08-01', DATE '2026-09-01', -1, 1, 1, 1, 1, 1, now());`,
  'offers_targets_non_negative',
);

console.log('\nMoney and month keys');

const DEP = '55555555-5555-5555-5555-555555555555';
await db.exec(`
  INSERT INTO deposits (id, offer_id, publisher_id, manager_id, account_name, account_email,
                        amount, method, current_balance, month_key, updated_at)
  VALUES ('${DEP}', '${OFFER}', '${PUB}', '${MGR}', 'Jane Doe', 'jane@example.com',
          100.00, 'card', 100.00, '2026-08', now());
`);

await mustReject(
  db,
  'zero deposit amount is rejected',
  `INSERT INTO deposits (id, offer_id, publisher_id, manager_id, account_name, account_email,
                         amount, method, current_balance, month_key, updated_at)
   VALUES (gen_random_uuid(), '${OFFER}', '${PUB}', '${MGR}', 'X', 'x@example.com',
           0, 'card', 0, '2026-08', now());`,
  'deposits_amount_positive',
);

await mustReject(
  db,
  'negative balance is rejected',
  `UPDATE deposits SET current_balance = -1 WHERE id = '${DEP}';`,
  'deposits_balance_non_negative',
);

await mustReject(
  db,
  'malformed month_key is rejected',
  `INSERT INTO deposits (id, offer_id, publisher_id, manager_id, account_name, account_email,
                         amount, method, current_balance, month_key, updated_at)
   VALUES (gen_random_uuid(), '${OFFER}', '${PUB}', '${MGR}', 'X', 'x@example.com',
           10, 'card', 10, 'XXXX-XX', now());`,
  'deposits_month_key_format',
);

await db.exec(`
  INSERT INTO balance_entries (id, deposit_id, type, amount, balance_before, balance_after, created_by_id)
  VALUES (gen_random_uuid(), '${DEP}', 'OPENING', 100.00, 0, 100.00, '${PUB}');
`);

await mustReject(
  db,
  'balance_entries cannot be updated',
  `UPDATE balance_entries SET amount = 999;`,
  'append-only',
);

console.log('\nSingle-use identity guarantee');

const TD = '66666666-6666-6666-6666-666666666666';
const TS1 = '77777777-7777-7777-7777-777777777777';
const TS2 = '88888888-8888-8888-8888-888888888888';
await db.exec(`
  INSERT INTO test_data (id, owner_user_id, country_code, first_name, last_name, status, updated_at)
  VALUES ('${TD}', '${SA}', 'US', 'Single', 'Use', 'USED', now());
  INSERT INTO task_sessions (id, offer_id, publisher_id, manager_id, type, expires_at)
  VALUES ('${TS1}', '${OFFER}', '${PUB}', '${MGR}', 'LEAD', now() + interval '30 min'),
         ('${TS2}', '${OFFER}', '${PUB}', '${MGR}', 'LEAD', now() + interval '30 min');
  INSERT INTO leads (id, offer_id, publisher_id, manager_id, test_data_id, task_session_id, month_key)
  VALUES (gen_random_uuid(), '${OFFER}', '${PUB}', '${MGR}', '${TD}', '${TS1}', '2026-08');
`);

await mustReject(
  db,
  'the same identity cannot produce a second lead',
  `INSERT INTO leads (id, offer_id, publisher_id, manager_id, test_data_id, task_session_id, month_key)
   VALUES (gen_random_uuid(), '${OFFER}', '${PUB}', '${MGR}', '${TD}', '${TS2}', '2026-08');`,
  'leads_test_data_id_key',
);

await mustReject(
  db,
  'an identity used by a lead cannot also be used by a deposit',
  `INSERT INTO deposits (id, offer_id, publisher_id, manager_id, test_data_id, account_name,
                         account_email, amount, method, current_balance, month_key, updated_at)
   SELECT gen_random_uuid(), '${OFFER}', '${PUB}', '${MGR}', '${TD}', 'X', 'x@example.com',
          10, 'card', 10, '2026-08', now()
   WHERE NOT EXISTS (SELECT 1 FROM deposits WHERE test_data_id = '${TD}');
   INSERT INTO deposits (id, offer_id, publisher_id, manager_id, test_data_id, account_name,
                         account_email, amount, method, current_balance, month_key, updated_at)
   VALUES (gen_random_uuid(), '${OFFER}', '${PUB}', '${MGR}', '${TD}', 'Y', 'y@example.com',
           10, 'card', 10, '2026-08', now());`,
  'deposits_test_data_id_key',
);

console.log('\nNotification dedupe');

await db.exec(`
  INSERT INTO notifications (id, user_id, type, title, dedupe_day)
  VALUES (gen_random_uuid(), '${PUB}', 'GAMEPLAY_OVERDUE', 'Overdue', '2026-08-15');
`);

await mustReject(
  db,
  'the same alert cannot be raised twice in one day',
  `INSERT INTO notifications (id, user_id, type, title, dedupe_day)
   VALUES (gen_random_uuid(), '${PUB}', 'GAMEPLAY_OVERDUE', 'Overdue', '2026-08-15');`,
  'notifications_user_id_type_entity_id_dedupe_day_key',
);

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
await db.close();
process.exit(failed === 0 ? 0 : 1);
