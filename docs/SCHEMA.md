# Database Schema — proposed

PostgreSQL 16. All ids are UUID v4. All tables carry `created_at`; mutable tables carry
`updated_at`. Money is `NUMERIC(14,2)`. Soft delete via a `status` enum rather than a
`deleted_at` column — nothing in this system is ever hard-deleted except expired
sessions.

## Design decisions worth stating up front

**One `users` table, not separate `managers` and `publishers` tables.** Role is an enum
and a publisher points at its manager through a self-referencing `manager_id`. This
makes "one primary manager per publisher" a foreign key rather than application logic,
and it means auth, sessions, and audit logs have a single subject table. Separate
tables would duplicate every auth column three times.

**Ownership drives visibility.** Every row that a Manager must be walled off from
carries an `owner_user_id`. The data-scoping middleware turns the requester role into a
WHERE clause: Super Admin gets no filter, Manager gets
`owner_user_id = me OR manager_id = me`, Publisher gets `publisher_id = me`. Visibility
is one rule applied in one place, not a permission check scattered through handlers.

**Ledgers, not overwrites.** Balances and statuses that carry money or accountability
are append-only tables with a cached current value on the parent row.

---

## users

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | citext UNIQUE | login identity |
| password_hash | text | Argon2id |
| full_name | text | |
| role | enum | `SUPER_ADMIN` \| `MANAGER` \| `PUBLISHER` |
| status | enum | `ACTIVE` \| `DISABLED` |
| manager_id | uuid FK -> users.id | publishers only |
| created_by_id | uuid FK -> users.id | |
| phone | text NULL | |
| last_login_at | timestamptz NULL | |
| failed_login_count | int default 0 | |
| locked_until | timestamptz NULL | brute-force lockout |
| must_change_password | bool default true | forced on first login |
| created_at / updated_at | timestamptz | |

Constraints:
- `CHECK ((role = 'PUBLISHER') = (manager_id IS NOT NULL))` — publishers must have a
  manager, non-publishers must not.
- Trigger enforcing that `manager_id` references a user whose role is `MANAGER`.
- Exactly one `SUPER_ADMIN` is created by the production bootstrap script; additional
  super admins are possible but require an existing super admin to create them.

Indexes: `(manager_id)`, `(role, status)`.

## sessions

`id`, `user_id` FK, `refresh_token_hash` (sha256, never the raw token), `expires_at`,
`ip_address`, `user_agent`, `revoked_at`, `created_at`.
Index `(user_id, expires_at)`. Expired rows purged nightly.

---

## offers

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | |
| brand | text | |
| description | text NULL | |
| notes | text NULL | internal notes |
| publisher_instructions | text NULL | shown on the task screen |
| country_code | char(2) | ISO 3166-1 alpha-2 |
| url | text | the offer link |
| status | enum | `DRAFT` `ACTIVE` `PAUSED` `EXPIRED` `COMPLETED` `ARCHIVED` |
| owner_user_id | uuid FK -> users | Super Admin or Manager who owns it |
| created_by_id | uuid FK -> users | |
| start_date | date | |
| expiry_date | date | default `start_date + settings.offer_default_duration_days` |
| monthly_lead_target | int | |
| monthly_deposit_target | int | |
| monthly_deposit_amount_target | numeric(14,2) | |
| lifetime_deposit_amount_target | numeric(14,2) NULL | optional overall cap |
| lead_interval_seconds | int | gap between leads, per publisher |
| deposit_interval_seconds | int | gap between deposits, per publisher |
| gameplay_interval_days | int | |
| data_source_policy | enum | `OWNER_ONLY` \| `OWNER_PLUS_SUPER_ADMIN` |
| deposit_identity_source | enum | `FROM_PRIOR_LEAD` \| `NEW_IDENTITY` \| `EITHER` |
| low_data_threshold | int default 10 | |
| currency | char(3) default 'USD' | future-proofing only |
| created_at / updated_at | timestamptz | |

Indexes: `(status, expiry_date)`, `(owner_user_id)`, `(country_code, status)`.

Expiry is display state, computed as `now() > expiry_date`. The nightly job flips
`status` to `EXPIRED` and raises a notification, but the red highlight in the UI comes
from the date comparison so it is correct even if the job has not run.

## offer_extensions

`id`, `offer_id` FK, `previous_expiry_date`, `new_expiry_date`, `extended_by_id`,
`reason` (text NULL), `created_at`. Every extension also writes an audit log row.

## offer_publishers

The assignment table, and the concurrency mutex for a (offer, publisher) pair.

`id`, `offer_id` FK, `publisher_id` FK, `monthly_lead_cap` (int NULL),
`monthly_deposit_cap` (int NULL), `active` bool, `assigned_by_id`, `assigned_at`.

`UNIQUE (offer_id, publisher_id)`.

A NULL cap means the publisher draws from the shared offer-level target. A set cap
means that publisher may not exceed their own allocation. See DECISIONS.md item 3.

---

## test_data

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| owner_user_id | uuid FK -> users | who uploaded it — drives visibility |
| import_batch_id | uuid FK NULL | |
| country_code | char(2) | |
| first_name / last_name | text | |
| email | citext NULL | |
| phone | text NULL | |
| address / city | text NULL | |
| state / postal_code | text NULL | |
| date_of_birth | date NULL | |
| extra | jsonb default '{}' | any additional configured columns |
| status | enum | `AVAILABLE` `RESERVED` `USED` `RELEASED` `DISABLED` |
| reserved_by_user_id | uuid FK NULL | |
| reserved_at | timestamptz NULL | |
| reservation_expires_at | timestamptz NULL | |
| used_at | timestamptz NULL | |
| used_by_user_id | uuid FK NULL | |
| used_offer_id | uuid FK NULL | |
| created_at / updated_at | timestamptz | |

Indexes:
- `(country_code, status, owner_user_id)` — the assignment query, most important index
  in the system
- `(status, reservation_expires_at)` — the sweeper
- partial unique `(owner_user_id, country_code, lower(email)) WHERE email IS NOT NULL`
- partial unique `(owner_user_id, country_code, phone) WHERE phone IS NOT NULL`

The two partial unique indexes are what make import duplicate detection reliable rather
than best-effort. They are scoped per owner so two managers uploading the same public
list do not collide with each other.

## import_batches

`id`, `owner_user_id`, `filename`, `country_code`, `column_mapping` jsonb,
`total_rows`, `valid_rows`, `invalid_rows`, `duplicate_rows`, `imported_rows`,
`error_report` jsonb, `status` (`PENDING_CONFIRM` `IMPORTED` `CANCELLED`), `created_at`.

`column_mapping` stores the user-chosen mapping from spreadsheet header to field, which
is what makes the importer format-agnostic. Uploaded files are parsed in memory,
validated, and discarded — the raw file is never persisted.

---

## task_sessions

The bridge between reserving an identity and completing the work. Without this, an
abandoned task leaks a reserved record forever.

`id`, `offer_id`, `publisher_id`, `manager_id` (snapshot), `type` (`LEAD` \| `DEPOSIT`),
`test_data_id` FK NULL, `proxy_id` FK NULL,
`status` (`OPEN` `COMPLETED` `ABANDONED` `EXPIRED`), `started_at`, `expires_at`,
`completed_at`.

Index `(publisher_id, status)`, `(status, expires_at)`.

## leads

`id`, `offer_id`, `publisher_id`, `manager_id`, `test_data_id`, `task_session_id`,
`proxy_id` NULL, `completed_at`, `month_key` (generated `YYYY-MM` in app timezone),
`notes` NULL.

- `UNIQUE (test_data_id)` — one identity produces at most one lead, ever. This is the
  database-level guarantee behind "never reused".
- Indexes: `(offer_id, publisher_id, completed_at DESC)` for the timer query,
  `(offer_id, month_key)` and `(publisher_id, month_key)` for counters.

## deposits

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| offer_id / publisher_id / manager_id | uuid FK | |
| lead_id | uuid FK NULL | the registration this deposit funds |
| test_data_id | uuid FK NULL | |
| account_name | text | |
| account_email | citext | |
| account_secret_enc | bytea NULL | AES-256-GCM, reveal is audited |
| amount | numeric(14,2) | |
| method | text | |
| currency | char(3) default 'USD' | |
| status | enum | `ACTIVE` \| `COMPLETED` |
| current_balance | numeric(14,2) | cached; ledger is the truth |
| last_gameplay_at | timestamptz NULL | |
| next_gameplay_due_at | timestamptz NULL | |
| deposited_at | timestamptz | |
| month_key | text generated | |
| created_at / updated_at | timestamptz | |

Indexes: `(offer_id, publisher_id, deposited_at DESC)`, `(status, next_gameplay_due_at)`
for the overdue query, `(manager_id, month_key)`, `(publisher_id, month_key)`.

## deposit_status_changes

`id`, `deposit_id`, `from_status`, `to_status`, `changed_by_id`, `note`, `created_at`.

## balance_entries

The append-only money ledger.

`id`, `deposit_id`, `type` (`OPENING` `TOPUP` `ADJUSTMENT` `WITHDRAWAL`), `amount`,
`balance_before`, `balance_after`, `note`, `created_by_id`, `created_at`.

Index `(deposit_id, created_at DESC)`. Rows are never updated or deleted; a mistake is
corrected with a compensating `ADJUSTMENT` entry.

## withdrawals

`id`, `deposit_id`, `publisher_id`, `manager_id`, `offer_id`, `amount`, `method` NULL,
`withdrawn_at`, `notes` NULL, `balance_entry_id` FK, `created_at`.

Creating a withdrawal writes the `balance_entries` row and updates
`deposits.current_balance` in the same transaction.

## gameplay_records

`id`, `deposit_id`, `publisher_id`, `confirmed_at`, `due_at_when_confirmed`,
`was_overdue` bool, `created_at`. Index `(deposit_id, confirmed_at DESC)`.

## advances

`id`, `publisher_id`, `manager_id`, `month_key`, `amount`, `paid_on` date NULL,
`status` (`PENDING` `PAID` `CANCELLED`), `notes` NULL, `created_by_id`, `created_at`.

Index `(publisher_id, month_key)`. Multiple advances per month are allowed; the
publisher view shows the month total.

---

## proxies

`id`, `label`, `host`, `port`, `protocol` (`HTTP` \| `HTTPS` \| `SOCKS5`), `username`,
`password_enc` bytea, `country_code`, `status` (`ACTIVE` \| `DISABLED`),
`owner_user_id`, `last_checked_at` NULL, `last_check_ok` bool NULL, `created_at`.

`password_enc` is AES-256-GCM. It is never included in list responses. A publisher
retrieves credentials only through `GET /proxies/:id/credentials`, which requires the
proxy to be attached to that publisher's currently open task session and writes an
audit entry on every call.

## proxy_assignments

`id`, `proxy_id`, `publisher_id` NULL, `offer_id` NULL, `test_data_id` NULL, `active`,
`assigned_at`, `assigned_by_id`.

A `test_data_id` assignment makes the proxy *sticky to the identity* — the same account
always reaches the brand from the same IP, which is what real testing needs.

---

## audit_logs

`id`, `actor_user_id`, `actor_role`, `action` (text enum-like), `entity_type`,
`entity_id`, `metadata` jsonb, `ip_address` inet, `user_agent`, `created_at`.

Indexes `(entity_type, entity_id, created_at DESC)`, `(actor_user_id, created_at DESC)`,
`(action, created_at DESC)`.

Append-only enforced at the database level: the application's Postgres role is granted
`INSERT, SELECT` on this table and nothing else. Even a compromised application cannot
rewrite history.

## notifications

`id`, `user_id`, `type`, `title`, `body`, `entity_type` NULL, `entity_id` NULL,
`read_at` NULL, `created_at`. Index `(user_id, read_at, created_at DESC)`.

Deduplicated per (user, type, entity) per day so a recurring condition such as overdue
gameplay does not produce a new row on every cron tick.

## system_settings

`key` PK, `value` jsonb, `updated_by_id`, `updated_at`.

Seeded keys: `app_timezone`, `offer_default_duration_days` (90),
`reservation_ttl_minutes` (30), `low_data_threshold_default` (10), `max_upload_mb`,
`task_session_ttl_minutes`.

---

## Relationship map

```
users (SUPER_ADMIN)
  └── users (MANAGER)  ──owns──> offers, test_data, proxies
        └── users (PUBLISHER)
              ├── offer_publishers ──> offers
              ├── task_sessions ──> test_data (reserved), proxies
              ├── leads ──> offer, test_data, task_session
              ├── deposits ──> offer, lead, test_data
              │     ├── balance_entries
              │     ├── withdrawals
              │     ├── gameplay_records
              │     └── deposit_status_changes
              └── advances
```

Every lead and every deposit carries `offer_id`, `manager_id`, `publisher_id`, and
`test_data_id` directly, so the traceability chain required in the brief
(Offer → Manager → Publisher → Test Data → Activity → Timestamp) is a single-row read
with no joins. The denormalised `manager_id` is a deliberate snapshot: if a publisher
is later moved to a different manager, historical reporting stays attributed to the
manager who actually supervised the work.
