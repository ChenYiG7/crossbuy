-- CreateTable
CREATE TABLE `member` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(50) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `password_algo` VARCHAR(16) NOT NULL DEFAULT 'argon2id',
    `email` VARCHAR(50) NULL,
    `name` VARCHAR(50) NULL,
    `en_name` VARCHAR(60) NULL,
    `member_id` VARCHAR(30) NULL,
    `face` VARCHAR(128) NULL,
    `sex` SMALLINT NULL DEFAULT 0,
    `tel` VARCHAR(50) NULL,
    `zip` VARCHAR(20) NULL,
    `country` VARCHAR(50) NULL,
    `city` VARCHAR(50) NULL,
    `address` VARCHAR(255) NULL,
    `qq` VARCHAR(20) NULL DEFAULT '',
    `msn` VARCHAR(50) NULL DEFAULT '',
    `line` VARCHAR(30) NULL,
    `wechat` VARCHAR(30) NULL,
    `card` VARCHAR(20) NULL,
    `utype` SMALLINT NULL DEFAULT 0,
    `use_type` TINYINT NULL,
    `state` SMALLINT NULL DEFAULT 1,
    `validity` INTEGER NULL,
    `reg_type` TINYINT NULL,
    `biz_code` VARCHAR(56) NOT NULL DEFAULT 'PROXY_PURCHASE',
    `belong_company` VARCHAR(32) NULL,
    `tag` VARCHAR(255) NULL,
    `balance` DECIMAL(12, 2) NULL DEFAULT 0.00,
    `balance_currency` VARCHAR(8) NULL DEFAULT 'JPY',
    `scores` INTEGER NULL DEFAULT 0,
    `float_rate` DECIMAL(10, 2) NULL DEFAULT 0.05,
    `last_balance_changed_at` DATETIME(0) NULL,
    `order_enable` TINYINT NULL DEFAULT 1,
    `stop_time` DATETIME(0) NULL,
    `df_flag` TINYINT NULL DEFAULT 0,
    `df_fee` DECIMAL(10, 2) NULL DEFAULT 10.00,
    `df_send_name` VARCHAR(50) NULL,
    `df_send_address` VARCHAR(200) NULL,
    `df_send_tel` VARCHAR(50) NULL,
    `csv_up_flag` TINYINT NULL DEFAULT 0,
    `realtime_account` VARCHAR(255) NULL,
    `shop_name` VARCHAR(100) NULL,
    `shop_url` VARCHAR(200) NULL,
    `pre_buy_feq` VARCHAR(60) NULL,
    `pre_buy_amt` VARCHAR(60) NULL,
    `mon_pay_amt` DECIMAL(12, 2) NULL DEFAULT 30000,
    `origin_package_choice` TINYINT NULL DEFAULT 0,
    `xz` VARCHAR(50) NULL DEFAULT '0',
    `fb` VARCHAR(11) NULL,
    `reg_extra` VARCHAR(1024) NULL,
    `remark` TEXT NULL,
    `mail_frequency` TINYINT NULL DEFAULT 4,
    `email_subscribe_status` INTEGER NULL,
    `cc_emails` JSON NULL,
    `login_limit_warning` TINYINT NULL DEFAULT 0,
    `stores_free_days` INTEGER NULL DEFAULT 90,
    `stores_warn_days` INTEGER NULL DEFAULT 82,
    `reg_ip` CHAR(16) NULL,
    `created_at` DATETIME(0) NOT NULL,
    `login_ip` CHAR(16) NULL,
    `last_login_at` DATETIME(0) NULL,
    `last_order_at` DATETIME(0) NULL,
    `active_key` CHAR(5) NULL,
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `member_username_key`(`username`),
    INDEX `member_email_idx`(`email`),
    INDEX `member_member_id_idx`(`member_id`),
    INDEX `member_biz_code_idx`(`biz_code`),
    INDEX `member_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_company` (
    `member_id` INTEGER NOT NULL,
    `name` VARCHAR(50) NULL,
    `eng_name` VARCHAR(50) NULL,
    `manager` VARCHAR(50) NULL,
    `manager_eng` VARCHAR(50) NULL,
    `post` VARCHAR(50) NULL,
    `tel` VARCHAR(30) NULL,
    `address` VARCHAR(255) NULL,
    `eng_address` VARCHAR(255) NULL,
    `zip` VARCHAR(255) NULL,
    `bus_num` VARCHAR(100) NULL,

    PRIMARY KEY (`member_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_address` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `consignee` VARCHAR(30) NOT NULL,
    `en_name` VARCHAR(100) NULL,
    `country` VARCHAR(30) NULL,
    `city` VARCHAR(30) NULL,
    `zip` VARCHAR(30) NULL,
    `tel` VARCHAR(30) NULL,
    `address` VARCHAR(255) NULL,
    `type` TINYINT NOT NULL DEFAULT 1,
    `email` VARCHAR(30) NULL,
    `bank_info` VARCHAR(255) NULL,
    `corporate_info` VARCHAR(255) NULL,
    `is_default` SMALLINT NULL DEFAULT 0,
    `customs_code` VARCHAR(255) NULL,
    `real_time_account` VARCHAR(255) NULL,
    `corporate_number` VARCHAR(100) NULL,
    `company_name` VARCHAR(50) NULL,

    INDEX `member_address_member_id_type_idx`(`member_id`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_webhook` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `secret` TEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `balance_low_threshold` DECIMAL(12, 2) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `member_webhook_member_id_key`(`member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_webhook_delivery` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `event` VARCHAR(64) NOT NULL,
    `event_key` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `last_status_code` SMALLINT UNSIGNED NULL,
    `last_error` VARCHAR(255) NULL,
    `next_attempt_at` TIMESTAMP(0) NULL,
    `delivered_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `member_webhook_delivery_event_key_key`(`event_key`),
    INDEX `member_webhook_delivery_member_id_created_at_idx`(`member_id`, `created_at`),
    INDEX `member_webhook_delivery_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `personal_access_token` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `tokenable_type` VARCHAR(255) NOT NULL,
    `tokenable_id` BIGINT NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `abilities` TEXT NULL,
    `last_used_at` TIMESTAMP(0) NULL,
    `expires_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `personal_access_token_token_key`(`token`),
    INDEX `personal_access_token_tokenable_type_tokenable_id_idx`(`tokenable_type`, `tokenable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_login` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `appid` VARCHAR(50) NOT NULL,
    `openid` VARCHAR(50) NOT NULL,
    `detail` TEXT NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `oauth_login_member_id_idx`(`member_id`),
    UNIQUE INDEX `oauth_login_openid_appid_key`(`openid`, `appid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_taobao_global` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `account` VARCHAR(50) NULL,
    `token` JSON NULL,
    `member_id` INTEGER NULL,
    `seller_id` VARCHAR(50) NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `open_api_idempotency` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `scope` VARCHAR(32) NOT NULL,
    `client_key` VARCHAR(64) NOT NULL,
    `request_hash` CHAR(64) NULL,
    `status` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `response` JSON NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `open_api_idempotency_created_at_idx`(`created_at`),
    UNIQUE INDEX `open_api_idempotency_member_id_scope_client_key_key`(`member_id`, `scope`, `client_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `favorite` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `category_id` INTEGER NOT NULL DEFAULT 0,
    `favoriteable_type` VARCHAR(255) NOT NULL,
    `favoriteable_id` INTEGER NOT NULL,
    `extra` TEXT NULL,
    `memo` VARCHAR(255) NOT NULL DEFAULT '',
    `created_at` DATETIME(0) NOT NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `favorite_member_id_category_id_idx`(`member_id`, `category_id`),
    INDEX `favorite_favoriteable_id_favoriteable_type_idx`(`favoriteable_id`, `favoriteable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `favorite_category` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL DEFAULT '',
    `type` TINYINT NULL DEFAULT 0,
    `sort` TINYINT UNSIGNED NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `favorite_category_member_id_idx`(`member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `browse_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `goods_id` INTEGER NOT NULL,
    `created_at` DATETIME(0) NOT NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `browse_history_member_id_created_at_idx`(`member_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `benefit_config` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `benefit_code` VARCHAR(50) NOT NULL,
    `benefit_name` VARCHAR(100) NOT NULL,
    `benefit_type` TINYINT NOT NULL,
    `benefit_config` JSON NULL,
    `valid_days` INTEGER NULL DEFAULT 0,
    `activity_start_at` TIMESTAMP(0) NULL,
    `activity_end_at` TIMESTAMP(0) NULL,
    `user_conditions` JSON NULL,
    `status` TINYINT NULL DEFAULT 1,
    `sort_order` INTEGER NULL DEFAULT 0,
    `features` JSON NULL,
    `remark` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `benefit_config_benefit_code_key`(`benefit_code`),
    INDEX `benefit_config_activity_start_at_activity_end_at_idx`(`activity_start_at`, `activity_end_at`),
    INDEX `benefit_config_benefit_type_idx`(`benefit_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_benefit` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `benefit_config_id` INTEGER NOT NULL,
    `benefit_code` VARCHAR(50) NOT NULL,
    `benefit_name` VARCHAR(100) NOT NULL,
    `benefit_type` TINYINT NOT NULL,
    `benefit_value` JSON NULL,
    `status` TINYINT NULL DEFAULT 1,
    `source` VARCHAR(50) NULL,
    `source_id` VARCHAR(100) NULL,
    `received_at` TIMESTAMP(0) NULL,
    `start_at` TIMESTAMP(0) NULL,
    `used_at` TIMESTAMP(0) NULL,
    `expired_at` TIMESTAMP(0) NULL,
    `features` JSON NULL,
    `remark` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `member_benefit_member_id_status_idx`(`member_id`, `status`),
    INDEX `member_benefit_benefit_config_id_idx`(`benefit_config_id`),
    INDEX `member_benefit_source_source_id_idx`(`source`, `source_id`),
    UNIQUE INDEX `member_benefit_member_id_benefit_config_id_key`(`member_id`, `benefit_config_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `member_operation_log` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `operator` INTEGER NOT NULL,
    `remark` VARCHAR(200) NULL DEFAULT '',
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `member_operation_log_member_id_idx`(`member_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `area` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `level` TINYINT UNSIGNED NOT NULL,
    `parent_id` INTEGER NOT NULL,
    `country_code` CHAR(2) NOT NULL,
    `official_code` VARCHAR(50) NULL,

    INDEX `area_country_code_idx`(`country_code`),
    INDEX `area_parent_id_idx`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_entry` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `direction` VARCHAR(2) NOT NULL,
    `amount` DECIMAL(12, 4) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `biz_no` VARCHAR(64) NULL,
    `flow_type` VARCHAR(32) NOT NULL,
    `ref_id` VARCHAR(64) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `ledger_entry_biz_no_idx`(`biz_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

