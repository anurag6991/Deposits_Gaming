-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'MANAGER', 'PUBLISHER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DataSourcePolicy" AS ENUM ('OWNER_PLUS_SUPER_ADMIN', 'OWNER_ONLY');

-- CreateEnum
CREATE TYPE "DepositIdentitySource" AS ENUM ('NEW_IDENTITY', 'FROM_PRIOR_LEAD', 'EITHER');

-- CreateEnum
CREATE TYPE "TestDataStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'USED', 'RELEASED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING_CONFIRM', 'IMPORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('LEAD', 'DEPOSIT');

-- CreateEnum
CREATE TYPE "TaskSessionStatus" AS ENUM ('OPEN', 'COMPLETED', 'ABANDONED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('ACTIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BalanceEntryType" AS ENUM ('OPENING', 'TOPUP', 'ADJUSTMENT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('RECORDED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProxyProtocol" AS ENUM ('HTTP', 'HTTPS', 'SOCKS5');

-- CreateEnum
CREATE TYPE "ProxyStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "phone" TEXT,
    "manager_id" UUID,
    "created_by_id" UUID,
    "last_login_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "publisher_instructions" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "url" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
    "owner_user_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "expiry_date" DATE NOT NULL,
    "monthly_lead_target" INTEGER NOT NULL,
    "monthly_deposit_target" INTEGER NOT NULL,
    "monthly_deposit_amount_target" DECIMAL(14,2) NOT NULL,
    "lifetime_deposit_amount_target" DECIMAL(14,2),
    "lead_interval_seconds" INTEGER NOT NULL,
    "deposit_interval_seconds" INTEGER NOT NULL,
    "gameplay_interval_days" INTEGER NOT NULL,
    "data_source_policy" "DataSourcePolicy" NOT NULL DEFAULT 'OWNER_PLUS_SUPER_ADMIN',
    "deposit_identity_source" "DepositIdentitySource" NOT NULL DEFAULT 'NEW_IDENTITY',
    "low_data_threshold" INTEGER NOT NULL DEFAULT 10,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_extensions" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "previous_expiry_date" DATE NOT NULL,
    "new_expiry_date" DATE NOT NULL,
    "extended_by_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offer_publishers" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "monthly_lead_cap" INTEGER,
    "monthly_deposit_cap" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offer_publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_data" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "import_batch_id" UUID,
    "country_code" CHAR(2) NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "date_of_birth" DATE,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "status" "TestDataStatus" NOT NULL DEFAULT 'AVAILABLE',
    "reserved_by_user_id" UUID,
    "reserved_at" TIMESTAMPTZ(6),
    "reservation_expires_at" TIMESTAMPTZ(6),
    "used_at" TIMESTAMPTZ(6),
    "used_by_user_id" UUID,
    "used_offer_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "test_data_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "column_mapping" JSONB NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "error_report" JSONB NOT NULL DEFAULT '[]',
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING_CONFIRM',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_sessions" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "type" "TaskType" NOT NULL,
    "test_data_id" UUID,
    "proxy_id" UUID,
    "status" "TaskSessionStatus" NOT NULL DEFAULT 'OPEN',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "task_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "test_data_id" UUID NOT NULL,
    "task_session_id" UUID NOT NULL,
    "proxy_id" UUID,
    "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "month_key" VARCHAR(7) NOT NULL,
    "notes" TEXT,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "lead_id" UUID,
    "test_data_id" UUID,
    "task_session_id" UUID,
    "account_name" TEXT NOT NULL,
    "account_email" TEXT NOT NULL,
    "account_secret_enc" BYTEA,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "status" "DepositStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "last_gameplay_at" TIMESTAMPTZ(6),
    "next_gameplay_due_at" TIMESTAMPTZ(6),
    "deposited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "month_key" VARCHAR(7) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_status_changes" (
    "id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "from_status" "DepositStatus" NOT NULL,
    "to_status" "DepositStatus" NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_entries" (
    "id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "type" "BalanceEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "balance_before" DECIMAL(14,2) NOT NULL,
    "balance_after" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT,
    "withdrawn_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'RECORDED',
    "balance_entry_id" UUID NOT NULL,
    "month_key" VARCHAR(7) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gameplay_records" (
    "id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at_when_confirmed" TIMESTAMPTZ(6),
    "was_overdue" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "gameplay_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advances" (
    "id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "manager_id" UUID NOT NULL,
    "month_key" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "paid_on" DATE,
    "status" "AdvanceStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proxies" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" "ProxyProtocol" NOT NULL DEFAULT 'HTTP',
    "username" TEXT,
    "password_enc" BYTEA,
    "country_code" CHAR(2) NOT NULL,
    "status" "ProxyStatus" NOT NULL DEFAULT 'ACTIVE',
    "owner_user_id" UUID NOT NULL,
    "last_checked_at" TIMESTAMPTZ(6),
    "last_check_ok" BOOLEAN,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "proxies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proxy_assignments" (
    "id" UUID NOT NULL,
    "proxy_id" UUID NOT NULL,
    "publisher_id" UUID,
    "offer_id" UUID,
    "test_data_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proxy_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "Role",
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" INET,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT NOT NULL DEFAULT '',
    "dedupe_day" VARCHAR(10) NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_manager_id_idx" ON "users"("manager_id");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "offers_status_expiry_date_idx" ON "offers"("status", "expiry_date");

-- CreateIndex
CREATE INDEX "offers_owner_user_id_idx" ON "offers"("owner_user_id");

-- CreateIndex
CREATE INDEX "offers_country_code_status_idx" ON "offers"("country_code", "status");

-- CreateIndex
CREATE INDEX "offer_extensions_offer_id_created_at_idx" ON "offer_extensions"("offer_id", "created_at");

-- CreateIndex
CREATE INDEX "offer_publishers_publisher_id_active_idx" ON "offer_publishers"("publisher_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "offer_publishers_offer_id_publisher_id_key" ON "offer_publishers"("offer_id", "publisher_id");

-- CreateIndex
CREATE INDEX "test_data_country_code_status_owner_user_id_idx" ON "test_data"("country_code", "status", "owner_user_id");

-- CreateIndex
CREATE INDEX "test_data_status_reservation_expires_at_idx" ON "test_data"("status", "reservation_expires_at");

-- CreateIndex
CREATE INDEX "test_data_import_batch_id_idx" ON "test_data"("import_batch_id");

-- CreateIndex
CREATE INDEX "import_batches_owner_user_id_created_at_idx" ON "import_batches"("owner_user_id", "created_at");

-- CreateIndex
CREATE INDEX "task_sessions_publisher_id_status_idx" ON "task_sessions"("publisher_id", "status");

-- CreateIndex
CREATE INDEX "task_sessions_status_expires_at_idx" ON "task_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "leads_test_data_id_key" ON "leads"("test_data_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_task_session_id_key" ON "leads"("task_session_id");

-- CreateIndex
CREATE INDEX "leads_offer_id_publisher_id_completed_at_idx" ON "leads"("offer_id", "publisher_id", "completed_at");

-- CreateIndex
CREATE INDEX "leads_offer_id_month_key_idx" ON "leads"("offer_id", "month_key");

-- CreateIndex
CREATE INDEX "leads_publisher_id_month_key_idx" ON "leads"("publisher_id", "month_key");

-- CreateIndex
CREATE INDEX "leads_manager_id_month_key_idx" ON "leads"("manager_id", "month_key");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_lead_id_key" ON "deposits"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_test_data_id_key" ON "deposits"("test_data_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_task_session_id_key" ON "deposits"("task_session_id");

-- CreateIndex
CREATE INDEX "deposits_offer_id_publisher_id_deposited_at_idx" ON "deposits"("offer_id", "publisher_id", "deposited_at");

-- CreateIndex
CREATE INDEX "deposits_status_next_gameplay_due_at_idx" ON "deposits"("status", "next_gameplay_due_at");

-- CreateIndex
CREATE INDEX "deposits_manager_id_month_key_idx" ON "deposits"("manager_id", "month_key");

-- CreateIndex
CREATE INDEX "deposits_publisher_id_month_key_idx" ON "deposits"("publisher_id", "month_key");

-- CreateIndex
CREATE INDEX "deposits_offer_id_month_key_idx" ON "deposits"("offer_id", "month_key");

-- CreateIndex
CREATE INDEX "deposit_status_changes_deposit_id_created_at_idx" ON "deposit_status_changes"("deposit_id", "created_at");

-- CreateIndex
CREATE INDEX "balance_entries_deposit_id_created_at_idx" ON "balance_entries"("deposit_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawals_balance_entry_id_key" ON "withdrawals"("balance_entry_id");

-- CreateIndex
CREATE INDEX "withdrawals_publisher_id_withdrawn_at_idx" ON "withdrawals"("publisher_id", "withdrawn_at");

-- CreateIndex
CREATE INDEX "withdrawals_manager_id_month_key_idx" ON "withdrawals"("manager_id", "month_key");

-- CreateIndex
CREATE INDEX "withdrawals_deposit_id_idx" ON "withdrawals"("deposit_id");

-- CreateIndex
CREATE INDEX "gameplay_records_deposit_id_confirmed_at_idx" ON "gameplay_records"("deposit_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "advances_publisher_id_month_key_idx" ON "advances"("publisher_id", "month_key");

-- CreateIndex
CREATE INDEX "advances_manager_id_month_key_idx" ON "advances"("manager_id", "month_key");

-- CreateIndex
CREATE INDEX "proxies_country_code_status_idx" ON "proxies"("country_code", "status");

-- CreateIndex
CREATE INDEX "proxies_owner_user_id_idx" ON "proxies"("owner_user_id");

-- CreateIndex
CREATE INDEX "proxy_assignments_publisher_id_offer_id_active_idx" ON "proxy_assignments"("publisher_id", "offer_id", "active");

-- CreateIndex
CREATE INDEX "proxy_assignments_proxy_id_active_idx" ON "proxy_assignments"("proxy_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "proxy_assignments_test_data_id_key" ON "proxy_assignments"("test_data_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx" ON "audit_logs"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_type_entity_id_dedupe_day_key" ON "notifications"("user_id", "type", "entity_id", "dedupe_day");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_extensions" ADD CONSTRAINT "offer_extensions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_extensions" ADD CONSTRAINT "offer_extensions_extended_by_id_fkey" FOREIGN KEY ("extended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_publishers" ADD CONSTRAINT "offer_publishers_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_publishers" ADD CONSTRAINT "offer_publishers_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offer_publishers" ADD CONSTRAINT "offer_publishers_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_data" ADD CONSTRAINT "test_data_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_data" ADD CONSTRAINT "test_data_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_data" ADD CONSTRAINT "test_data_reserved_by_user_id_fkey" FOREIGN KEY ("reserved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_data" ADD CONSTRAINT "test_data_used_by_user_id_fkey" FOREIGN KEY ("used_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_data" ADD CONSTRAINT "test_data_used_offer_id_fkey" FOREIGN KEY ("used_offer_id") REFERENCES "offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_test_data_id_fkey" FOREIGN KEY ("test_data_id") REFERENCES "test_data"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_proxy_id_fkey" FOREIGN KEY ("proxy_id") REFERENCES "proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_test_data_id_fkey" FOREIGN KEY ("test_data_id") REFERENCES "test_data"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_task_session_id_fkey" FOREIGN KEY ("task_session_id") REFERENCES "task_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_proxy_id_fkey" FOREIGN KEY ("proxy_id") REFERENCES "proxies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_test_data_id_fkey" FOREIGN KEY ("test_data_id") REFERENCES "test_data"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_task_session_id_fkey" FOREIGN KEY ("task_session_id") REFERENCES "task_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_status_changes" ADD CONSTRAINT "deposit_status_changes_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_status_changes" ADD CONSTRAINT "deposit_status_changes_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_entries" ADD CONSTRAINT "balance_entries_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_entries" ADD CONSTRAINT "balance_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_balance_entry_id_fkey" FOREIGN KEY ("balance_entry_id") REFERENCES "balance_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gameplay_records" ADD CONSTRAINT "gameplay_records_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gameplay_records" ADD CONSTRAINT "gameplay_records_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances" ADD CONSTRAINT "advances_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances" ADD CONSTRAINT "advances_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advances" ADD CONSTRAINT "advances_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxies" ADD CONSTRAINT "proxies_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_assignments" ADD CONSTRAINT "proxy_assignments_proxy_id_fkey" FOREIGN KEY ("proxy_id") REFERENCES "proxies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_assignments" ADD CONSTRAINT "proxy_assignments_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_assignments" ADD CONSTRAINT "proxy_assignments_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_assignments" ADD CONSTRAINT "proxy_assignments_test_data_id_fkey" FOREIGN KEY ("test_data_id") REFERENCES "test_data"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_assignments" ADD CONSTRAINT "proxy_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
