-- CreateTable
CREATE TABLE `accounts` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(24) NOT NULL,
    `member_id` INTEGER NOT NULL DEFAULT 0,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
    `balance` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    `opening_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `row_version` INTEGER NOT NULL DEFAULT 0,
    `last_changed_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `accounts_member_id_idx`(`member_id`),
    UNIQUE INDEX `accounts_kind_currency_member_id_key`(`kind`, `currency`, `member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_entries` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT NOT NULL,
    `direction` VARCHAR(4) NOT NULL,
    `signed_amount` DECIMAL(14, 2) NOT NULL,
    `balance_before` DECIMAL(14, 2) NOT NULL,
    `balance_after` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
    `flow_type` VARCHAR(40) NOT NULL,
    `channel` VARCHAR(24) NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `order_id` INTEGER NULL,
    `send_order_id` INTEGER NULL,
    `recharge_order_id` BIGINT NULL,
    `counterpart_amount` DECIMAL(14, 2) NULL,
    `bargain_amount` DECIMAL(14, 2) NULL,
    `freight_amount` DECIMAL(14, 2) NULL,
    `rate` DECIMAL(12, 8) NULL,
    `rate_source` VARCHAR(16) NULL,
    `rate_ref_id` BIGINT NULL,
    `fee_rule_snapshot` JSON NULL,
    `operator_id` INTEGER NULL,
    `approval_id` BIGINT NULL,
    `adjust_reason` VARCHAR(32) NULL,
    `corrects_entry_id` BIGINT NULL,
    `pair_key` VARCHAR(64) NULL,
    `label` VARCHAR(255) NULL,
    `voucher_no` VARCHAR(32) NULL,
    `logistics_no` VARCHAR(64) NULL,
    `logistics_nos` JSON NULL,
    `biz_nos` JSON NULL,
    `legacy_source` VARCHAR(32) NULL,
    `legacy_id` BIGINT NULL,
    `occurred_at` DATETIME(0) NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ledger_entries_account_id_flow_type_occurred_at_idx`(`account_id`, `flow_type`, `occurred_at`),
    INDEX `ledger_entries_order_id_idx`(`order_id`),
    INDEX `ledger_entries_send_order_id_idx`(`send_order_id`),
    INDEX `ledger_entries_recharge_order_id_idx`(`recharge_order_id`),
    INDEX `ledger_entries_pair_key_idx`(`pair_key`),
    UNIQUE INDEX `ledger_entries_account_id_idempotency_key_key`(`account_id`, `idempotency_key`),
    UNIQUE INDEX `ledger_entries_legacy_source_legacy_id_key`(`legacy_source`, `legacy_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recharge_orders` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `source_amount` DECIMAL(14, 2) NOT NULL,
    `source_currency` VARCHAR(8) NOT NULL DEFAULT 'JPY',
    `credited_amount` DECIMAL(14, 2) NOT NULL,
    `rate` DECIMAL(12, 8) NOT NULL,
    `rate_source` VARCHAR(16) NOT NULL DEFAULT 'HUILV',
    `channel` VARCHAR(24) NOT NULL,
    `channel_label` VARCHAR(64) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `gateway_transaction_no` VARCHAR(128) NULL,
    `submitted_by_admin_id` INTEGER NULL,
    `audited_by_admin_id` INTEGER NULL,
    `proof_attachment_url` VARCHAR(200) NULL,
    `bank_name` VARCHAR(64) NULL,
    `payer_tel` VARCHAR(20) NULL,
    `source_system` VARCHAR(32) NULL,
    `submitted_at` DATETIME(0) NULL,
    `credited_at` DATETIME(0) NULL,
    `ledger_entry_id` BIGINT NULL,
    `notes` JSON NULL,
    `deleted_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `recharge_orders_member_id_status_idx`(`member_id`, `status`),
    INDEX `recharge_orders_status_credited_at_idx`(`status`, `credited_at`),
    UNIQUE INDEX `recharge_orders_gateway_transaction_no_key`(`gateway_transaction_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_rates` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `base` VARCHAR(8) NOT NULL,
    `quote` VARCHAR(8) NOT NULL,
    `rate` DECIMAL(12, 8) NOT NULL,
    `source` VARCHAR(16) NOT NULL,
    `spread_applied` DECIMAL(12, 8) NOT NULL DEFAULT 0,
    `effective_at` DATETIME(0) NOT NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `exchange_rates_base_quote_effective_at_key`(`base`, `quote`, `effective_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_batches` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(24) NOT NULL,
    `window_from` DATETIME(0) NOT NULL,
    `window_to` DATETIME(0) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
    `expected_total` DECIMAL(14, 2) NULL,
    `actual_total` DECIMAL(14, 2) NULL,
    `diff_amount` DECIMAL(14, 2) NULL,
    `diff_count` INTEGER NOT NULL DEFAULT 0,
    `handled_by_admin_id` INTEGER NULL,
    `finished_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `reconciliation_batches_type_status_idx`(`type`, `status`),
    UNIQUE INDEX `reconciliation_batches_type_window_from_window_to_key`(`type`, `window_from`, `window_to`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_diffs` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `batch_id` BIGINT NOT NULL,
    `left_key` VARCHAR(128) NOT NULL,
    `right_key` VARCHAR(128) NULL,
    `expected_amount` DECIMAL(14, 2) NOT NULL,
    `actual_amount` DECIMAL(14, 2) NOT NULL,
    `diff_amount` DECIMAL(14, 2) NOT NULL,
    `reason_code` VARCHAR(32) NOT NULL,
    `disposition` VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    `handled_by_admin_id` INTEGER NULL,
    `alert_event_id` BIGINT NULL,
    `detail` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `reconciliation_diffs_disposition_reason_code_idx`(`disposition`, `reason_code`),
    UNIQUE INDEX `reconciliation_diffs_batch_id_left_key_reason_code_key`(`batch_id`, `left_key`, `reason_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fee_rules` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(40) NOT NULL,
    `value` DECIMAL(12, 8) NOT NULL,
    `mode` VARCHAR(16) NOT NULL,
    `currency` VARCHAR(8) NULL,
    `member_tier` VARCHAR(24) NULL,
    `effective_from` DATETIME(0) NOT NULL,
    `updated_by` INTEGER NULL,
    `note` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    UNIQUE INDEX `fee_rules_code_effective_from_key`(`code`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alert_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(40) NOT NULL,
    `dedup_key` VARCHAR(128) NOT NULL,
    `severity` VARCHAR(8) NOT NULL DEFAULT 'WARN',
    `payload` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `sent_at` DATETIME(0) NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `alert_events_status_created_at_idx`(`status`, `created_at`),
    UNIQUE INDEX `alert_events_dedup_key_key`(`dedup_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alert_channels` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(40) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `credential_ref` VARCHAR(128) NOT NULL,
    `sign_type` VARCHAR(16) NULL,
    `msg_type` VARCHAR(16) NOT NULL DEFAULT 'MARKDOWN',
    `config` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `note` VARCHAR(255) NULL,
    `deleted_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    UNIQUE INDEX `alert_channels_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `alert_rules` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(40) NOT NULL,
    `channel_id` BIGINT NOT NULL,
    `severity` VARCHAR(8) NOT NULL DEFAULT 'WARN',
    `threshold_value` DECIMAL(14, 2) NULL,
    `threshold_json` JSON NULL,
    `silence_window_sec` INTEGER NOT NULL DEFAULT 3600,
    `schedule_cron` VARCHAR(64) NULL,
    `chunk_size` INTEGER NOT NULL DEFAULT 100,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `note` VARCHAR(255) NULL,
    `deleted_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `alert_rules_channel_id_enabled_idx`(`channel_id`, `enabled`),
    UNIQUE INDEX `alert_rules_code_channel_id_key`(`code`, `channel_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `legacy_sync_watermarks` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `source_table` VARCHAR(64) NOT NULL,
    `legacy_source` VARCHAR(32) NOT NULL,
    `last_legacy_id` BIGINT NOT NULL DEFAULT 0,
    `last_window_end` DATETIME(0) NULL,
    `overlap_count` INTEGER NOT NULL DEFAULT 200,
    `skipped_rows` BIGINT NOT NULL DEFAULT 0,
    `lag_rows` BIGINT NOT NULL DEFAULT 0,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `last_run_at` DATETIME(0) NULL,
    `last_success_at` DATETIME(0) NULL,
    `last_error` VARCHAR(500) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    INDEX `legacy_sync_watermarks_status_last_run_at_idx`(`status`, `last_run_at`),
    UNIQUE INDEX `legacy_sync_watermarks_source_table_key`(`source_table`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_entry_orders` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `entry_id` BIGINT NOT NULL,
    `order_id` INTEGER NOT NULL,
    `allocated_amount` DECIMAL(14, 2) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ledger_entry_orders_order_id_idx`(`order_id`),
    UNIQUE INDEX `ledger_entry_orders_entry_id_order_id_key`(`entry_id`, `order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

