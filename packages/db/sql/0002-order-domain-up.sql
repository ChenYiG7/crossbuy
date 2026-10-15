-- CreateTable
CREATE TABLE `order_groups` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tid` VARCHAR(64) NULL,
    `legacy_order_id` INTEGER NULL,
    `member_id` INTEGER NOT NULL,
    `supplier_shop_id` INTEGER NULL,
    `bargain_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `bargain_refunded_at` DATETIME(0) NULL,
    `shipping_fee_total` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,

    UNIQUE INDEX `order_groups_tid_key`(`tid`),
    UNIQUE INDEX `order_groups_legacy_order_id_key`(`legacy_order_id`),
    INDEX `order_groups_member_id_created_at_idx`(`member_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `group_id` INTEGER NULL,
    `member_id` INTEGER NOT NULL,
    `type` SMALLINT NOT NULL DEFAULT 1,
    `status` SMALLINT NOT NULL DEFAULT 1,
    `status_entered_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `source` VARCHAR(16) NOT NULL DEFAULT 'web',
    `creation_mode` VARCHAR(16) NOT NULL DEFAULT 'one_click',
    `source_ref` VARCHAR(64) NULL,
    `out_id` VARCHAR(80) NULL,
    `belong_company` VARCHAR(32) NULL,
    `pay_id` VARCHAR(50) NULL,
    `xz_assignee` VARCHAR(50) NULL,
    `goods_id` VARCHAR(20) NULL,
    `goods_url` VARCHAR(512) NULL,
    `goods_name` VARCHAR(255) NOT NULL,
    `goods_img` VARCHAR(255) NULL,
    `order_img` VARCHAR(255) NULL,
    `sku_name` VARCHAR(1024) NOT NULL DEFAULT '',
    `goods_size` VARCHAR(20) NULL,
    `goods_color` VARCHAR(20) NULL,
    `goods_seller` VARCHAR(50) NULL,
    `goods_site` VARCHAR(50) NULL,
    `supplier_shop_id` INTEGER NULL,
    `supplier_product_id` INTEGER NULL,
    `df_goods_name` VARCHAR(20) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `bargained_unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `promo_price` DECIMAL(12, 2) NULL,
    `shipping_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `purchase_unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `purchase_shipping_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `inspection_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `charged_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `charged_currency` VARCHAR(3) NOT NULL DEFAULT 'JPY',
    `service_fee_offset` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `send_order_id` INTEGER NULL,
    `domestic_tracking_no` VARCHAR(100) NULL,
    `reissue_no` VARCHAR(255) NULL,
    `reissue_seq` INTEGER NULL,
    `is_after_sale` BOOLEAN NOT NULL DEFAULT false,
    `weight_grams` INTEGER NULL,
    `ship_method` SMALLINT NULL,
    `is_sensitive` BOOLEAN NOT NULL DEFAULT false,
    `df_store_mode` BOOLEAN NOT NULL DEFAULT false,
    `terms` JSON NULL,
    `is_urgent` BOOLEAN NOT NULL DEFAULT false,
    `is_favorite` BOOLEAN NOT NULL DEFAULT false,
    `arrival_mark` TINYINT UNSIGNED NULL DEFAULT 0,
    `inspection_options` JSON NULL,
    `asin` VARCHAR(64) NULL,
    `fnsku` VARCHAR(64) NULL,
    `fba_shipment_id` VARCHAR(64) NULL,
    `buyer_remark` VARCHAR(512) NULL,
    `admin_remark` VARCHAR(512) NULL,
    `remarks_extra` JSON NULL,
    `extend_extra` JSON NULL,
    `auto_order_error` VARCHAR(512) NULL,
    `legacy_state_times` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `orders_member_id_created_at_idx`(`member_id`, `created_at`),
    INDEX `orders_status_idx`(`status`),
    INDEX `orders_group_id_idx`(`group_id`),
    INDEX `orders_out_id_idx`(`out_id`),
    INDEX `orders_source_created_at_idx`(`source`, `created_at`),
    INDEX `orders_domestic_tracking_no_idx`(`domestic_tracking_no`),
    INDEX `orders_send_order_id_idx`(`send_order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_status_histories` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `from_status` SMALLINT NULL,
    `to_status` SMALLINT NOT NULL,
    `operator_type` VARCHAR(16) NOT NULL,
    `operator_id` INTEGER NULL,
    `reason` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `order_status_histories_order_id_created_at_idx`(`order_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_extensions` (
    `order_id` INTEGER NOT NULL,
    `goods_name_trans` VARCHAR(255) NULL,
    `sku_trans` JSON NULL,
    `coupon_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `seller_change_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `instant_chat_tag` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    PRIMARY KEY (`order_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_client_refs` (
    `order_id` INTEGER NOT NULL,
    `member_id` INTEGER NOT NULL,
    `client_order_id` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(0) NULL,

    INDEX `order_client_refs_member_id_client_order_id_idx`(`member_id`, `client_order_id`),
    PRIMARY KEY (`order_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_platform_creations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `platform` VARCHAR(32) NOT NULL,
    `creation_mode` VARCHAR(16) NOT NULL DEFAULT 'auto',
    `platform_sub_account_id` INTEGER NOT NULL DEFAULT 0,
    `platform_trade_id` VARCHAR(50) NOT NULL,
    `platform_sub_trade_id` VARCHAR(50) NOT NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    UNIQUE INDEX `order_platform_creations_order_id_key`(`order_id`),
    INDEX `order_platform_creations_platform_trade_id_platform_sub_trad_idx`(`platform_trade_id`, `platform_sub_trade_id`),
    INDEX `order_platform_creations_order_id_idx`(`order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_sub_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `appid` VARCHAR(32) NOT NULL,
    `member_ref` VARCHAR(32) NULL,
    `out_user_id` VARCHAR(32) NULL,
    `username` VARCHAR(255) NOT NULL,
    `account_type` VARCHAR(30) NOT NULL,
    `token` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_trade_amounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `platform` VARCHAR(32) NOT NULL,
    `tid` VARCHAR(64) NOT NULL,
    `first_stage` VARCHAR(32) NOT NULL,
    `first_snapshot_at` DATETIME(0) NULL,
    `first_goods_total` DECIMAL(12, 2) NULL,
    `first_shipping_fee` DECIMAL(12, 2) NULL,
    `first_total_amount` DECIMAL(12, 2) NULL,
    `first_raw` JSON NULL,
    `latest_stage` VARCHAR(32) NOT NULL,
    `latest_snapshot_at` DATETIME(0) NULL,
    `latest_goods_total` DECIMAL(12, 2) NULL,
    `latest_shipping_fee` DECIMAL(12, 2) NULL,
    `latest_total_amount` DECIMAL(12, 2) NULL,
    `latest_coupon_fee` DECIMAL(12, 2) NULL,
    `latest_seller_adjust` DECIMAL(12, 2) NULL,
    `latest_raw` JSON NULL,
    `paid_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    UNIQUE INDEX `platform_trade_amounts_tid_platform_key`(`tid`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop_id` INTEGER NOT NULL,
    `unique_id` VARCHAR(100) NOT NULL,
    `platform_order_sn` VARCHAR(100) NOT NULL,
    `platform_order_status` VARCHAR(50) NOT NULL,
    `platform_modified_at` DATETIME(0) NULL,
    `detail` JSON NULL,
    `status` SMALLINT NOT NULL DEFAULT 1,
    `is_fulfilled` BOOLEAN NOT NULL DEFAULT false,
    `fulfillment_failure_reason` VARCHAR(1000) NULL,
    `total_amount` DECIMAL(12, 2) NULL,
    `currency` VARCHAR(3) NULL,
    `shipping_info` JSON NULL,
    `ordered_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `platform_orders_status_idx`(`status`),
    UNIQUE INDEX `platform_orders_shop_id_unique_id_key`(`shop_id`, `unique_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_order_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `sku_id` INTEGER NOT NULL,
    `unique_id` VARCHAR(100) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unit_price` DECIMAL(12, 2) NULL,
    `unit_currency` VARCHAR(3) NULL,
    `total_price` DECIMAL(12, 2) NULL,
    `total_currency` VARCHAR(3) NULL,
    `product_snapshot` JSON NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `platform_order_items_sku_id_idx`(`sku_id`),
    UNIQUE INDEX `platform_order_items_order_id_unique_id_key`(`order_id`, `unique_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shops` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `platform` VARCHAR(50) NOT NULL,
    `unique_id` VARCHAR(50) NULL,
    `name` VARCHAR(100) NOT NULL,
    `url` VARCHAR(100) NULL,
    `marketplace_id` VARCHAR(100) NULL,
    `seller_id` VARCHAR(100) NULL,
    `api_credentials` JSON NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'JPY',
    `timezone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Tokyo',
    `description` TEXT NULL,
    `status` TINYINT NOT NULL DEFAULT 0,
    `connection_status` TINYINT NOT NULL DEFAULT 0,
    `last_verified_at` DATETIME(0) NULL,
    `auth_expires_at` DATETIME(0) NULL,
    `last_verified_status` TINYINT NULL DEFAULT 0,
    `last_verified_message` VARCHAR(500) NULL,
    `use_store` BOOLEAN NOT NULL DEFAULT false,
    `auto_sync_orders` BOOLEAN NOT NULL DEFAULT false,
    `last_sync_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `restored_at` DATETIME(0) NULL,
    `deleted_by_member_id` INTEGER NULL,
    `restored_by_member_id` INTEGER NULL,

    INDEX `shops_member_id_platform_idx`(`member_id`, `platform`),
    INDEX `shops_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_products` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop_id` INTEGER NOT NULL,
    `unique_id` VARCHAR(100) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `goods_url` VARCHAR(500) NULL,
    `img_url` VARCHAR(300) NOT NULL,
    `platform_status` TINYINT NULL DEFAULT 0,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    UNIQUE INDEX `platform_products_shop_id_unique_id_key`(`shop_id`, `unique_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_product_skus` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop_id` INTEGER NOT NULL,
    `product_id` INTEGER NOT NULL,
    `unique_id` VARCHAR(100) NOT NULL,
    `sku` VARCHAR(255) NOT NULL,
    `fnsku` VARCHAR(255) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `img_url` VARCHAR(300) NOT NULL,
    `attribute` JSON NULL,
    `price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `platform_inventory` JSON NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `platform_product_skus_shop_id_idx`(`shop_id`),
    UNIQUE INDEX `platform_product_skus_product_id_unique_id_key`(`product_id`, `unique_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_sku_order_links` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `sku_id` INTEGER NOT NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    UNIQUE INDEX `platform_sku_order_links_sku_id_order_id_key`(`sku_id`, `order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_value_added_services` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `service_id` INTEGER NOT NULL,
    `name_snapshot` VARCHAR(255) NOT NULL,
    `remark` VARCHAR(255) NULL,
    `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `qty` INTEGER NOT NULL DEFAULT 1,
    `fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `order_value_added_services_order_id_idx`(`order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_splits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NULL,
    `split_from_order_id` INTEGER NULL,
    `quantity` INTEGER NOT NULL DEFAULT 0,
    `member_id` INTEGER NULL,
    `created_at` DATETIME(0) NULL,

    INDEX `order_splits_order_id_idx`(`order_id`),
    INDEX `order_splits_split_from_order_id_idx`(`split_from_order_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inquiry_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `inquiry_no` VARCHAR(64) NOT NULL,
    `member_id` INTEGER NULL,
    `status` TINYINT NULL DEFAULT 0,
    `po_file_url` VARCHAR(500) NULL,
    `quotation_file_url` VARCHAR(500) NULL,
    `item_count` INTEGER NULL DEFAULT 0,
    `quoted_item_count` INTEGER NULL DEFAULT 0,
    `is_deleted` TINYINT NULL DEFAULT 0,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    UNIQUE INDEX `inquiry_orders_inquiry_no_key`(`inquiry_no`),
    INDEX `inquiry_orders_member_id_is_deleted_created_at_idx`(`member_id`, `is_deleted`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inquiry_order_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `inquiry_item_no` VARCHAR(64) NOT NULL,
    `inquiry_no` VARCHAR(64) NOT NULL,
    `product_img_url` VARCHAR(500) NULL,
    `product_title` VARCHAR(500) NULL,
    `product_title_trans` VARCHAR(500) NULL,
    `seller_name` VARCHAR(255) NULL,
    `quantity` INTEGER NULL DEFAULT 1,
    `spec_desc` VARCHAR(1000) NULL,
    `spec_desc_trans` JSON NULL,
    `product_id` INTEGER NULL,
    `sku_id` INTEGER NULL,
    `product_remark` VARCHAR(1000) NULL,
    `product_price` DECIMAL(12, 2) NULL,
    `quoted_unit_price` DECIMAL(12, 2) NULL,
    `product_url` VARCHAR(500) NULL,
    `product_site` VARCHAR(100) NULL,
    `member_id` INTEGER NULL,
    `is_deleted` TINYINT NULL DEFAULT 0,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    UNIQUE INDEX `inquiry_order_items_inquiry_item_no_key`(`inquiry_item_no`),
    INDEX `inquiry_order_items_inquiry_no_product_id_sku_id_idx`(`inquiry_no`, `product_id`, `sku_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_batches` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NULL,
    `type` TINYINT NULL,
    `status` TINYINT NULL DEFAULT 0,
    `memo` VARCHAR(500) NULL,
    `file_name` VARCHAR(100) NULL,
    `notify_state` TINYINT UNSIGNED NULL DEFAULT 0,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `import_batches_member_id_idx`(`member_id`),
    INDEX `import_batches_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_items` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `batch_id` BIGINT NOT NULL,
    `member_id` INTEGER NULL,
    `type` TINYINT NULL,
    `goods_url` VARCHAR(300) NULL,
    `goods_name` VARCHAR(200) NULL,
    `goods_id` VARCHAR(20) NULL,
    `supplier_product_id` INTEGER NOT NULL DEFAULT 0,
    `goods_img` VARCHAR(255) NULL,
    `goods_site` VARCHAR(30) NULL,
    `unit_price` DECIMAL(12, 2) NULL,
    `quantity` INTEGER NULL,
    `sku_name` VARCHAR(1024) NULL,
    `color` VARCHAR(30) NULL,
    `size` VARCHAR(30) NULL,
    `seller` VARCHAR(100) NULL,
    `remark` VARCHAR(200) NULL,
    `order_remark` VARCHAR(200) NULL,
    `consignee` VARCHAR(50) NULL,
    `tel` VARCHAR(30) NULL,
    `zip` VARCHAR(30) NULL,
    `address` VARCHAR(200) NULL,
    `out_id` VARCHAR(50) NULL,
    `status` TINYINT NULL DEFAULT 0,
    `pro_info` VARCHAR(100) NULL,
    `ordered_at` DATETIME(0) NULL,
    `order_id` BIGINT NULL,
    `data_from` TINYINT NULL DEFAULT 0,
    `max_price` DECIMAL(12, 2) NULL,
    `original_order_id` BIGINT NULL,
    `created_at` DATETIME(0) NULL,
    `deleted_at` DATETIME(0) NULL,

    INDEX `import_items_out_id_idx`(`out_id`),
    INDEX `import_items_order_id_idx`(`order_id`),
    INDEX `import_items_batch_id_idx`(`batch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_invalid_marks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NULL,
    `admin_id` INTEGER NULL DEFAULT 0,
    `type` TINYINT NULL DEFAULT 0,
    `item_id` VARCHAR(30) NULL,
    `status` TINYINT NULL DEFAULT 0,
    `extra` VARCHAR(200) NULL,
    `memo` VARCHAR(50) NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `order_invalid_marks_order_id_idx`(`order_id`),
    INDEX `order_invalid_marks_item_id_idx`(`item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `member_id` INTEGER NOT NULL,
    `status` INTEGER NOT NULL,
    `box_no` VARCHAR(5) NOT NULL DEFAULT '0',
    `assignee` VARCHAR(255) NOT NULL,
    `operator` VARCHAR(255) NOT NULL,
    `user_content` VARCHAR(500) NOT NULL,
    `admin_content` VARCHAR(500) NOT NULL,
    `images` VARCHAR(1024) NULL,
    `is_focused` BOOLEAN NOT NULL DEFAULT false,
    `is_user_focused` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(0) NULL,

    INDEX `order_messages_order_id_created_at_idx`(`order_id`, `created_at`),
    INDEX `order_messages_member_id_created_at_idx`(`member_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `examination_records` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NULL,
    `tid` VARCHAR(60) NULL,
    `domestic_tracking_no` VARCHAR(60) NULL,
    `order_type` VARCHAR(10) NULL,
    `item_id` VARCHAR(30) NULL,
    `creator_id` INTEGER NULL,
    `salesman` VARCHAR(4) NULL,
    `reason` VARCHAR(20) NULL,
    `detail` VARCHAR(200) NULL,
    `detail_ja` VARCHAR(200) NULL,
    `images` VARCHAR(1000) NULL,
    `status` TINYINT NULL DEFAULT 1,
    `extra` VARCHAR(1000) NULL,
    `memo` VARCHAR(200) NULL,
    `created_at` DATETIME(0) NULL,
    `updated_at` DATETIME(0) NULL,

    INDEX `examination_records_tid_idx`(`tid`),
    INDEX `examination_records_domestic_tracking_no_idx`(`domestic_tracking_no`),
    INDEX `examination_records_item_id_idx`(`item_id`),
    INDEX `examination_records_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_examinations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `order_id` INTEGER NOT NULL,
    `examination_id` INTEGER NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `order_examinations_order_id_idx`(`order_id`),
    INDEX `order_examinations_examination_id_idx`(`examination_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `member_id` INTEGER NOT NULL,
    `type` SMALLINT NULL DEFAULT 1,
    `tid` VARCHAR(50) NULL,
    `goods_id` VARCHAR(20) NULL,
    `goods_url` VARCHAR(255) NULL,
    `goods_name` VARCHAR(255) NOT NULL,
    `goods_img` VARCHAR(255) NULL,
    `sku_name` VARCHAR(1024) NOT NULL DEFAULT '',
    `goods_size` VARCHAR(20) NULL,
    `goods_color` VARCHAR(20) NULL,
    `goods_seller` VARCHAR(50) NULL,
    `seller_url` VARCHAR(255) NULL,
    `goods_site` VARCHAR(50) NULL,
    `site_url` VARCHAR(255) NULL,
    `supplier_product_id` INTEGER NOT NULL DEFAULT 0,
    `domestic_tracking_no` VARCHAR(50) NULL,
    `quantity` INTEGER NULL DEFAULT 1,
    `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `offer_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `retail_price` DECIMAL(12, 2) NULL,
    `one_piece_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `shipping_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `promo_price` DECIMAL(12, 2) NULL,
    `inspection_fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `min_order_quantity` SMALLINT UNSIGNED NULL DEFAULT 0,
    `goods_name_trans` VARCHAR(255) NULL,
    `sku_trans` VARCHAR(255) NULL,
    `terms` JSON NULL,
    `ship_method` TINYINT NULL DEFAULT 0,
    `inspection_options` JSON NULL,
    `asin` VARCHAR(64) NULL,
    `fnsku` VARCHAR(64) NULL,
    `out_id` VARCHAR(80) NULL,
    `add_from` TINYINT NULL DEFAULT 0,
    `add_from_memo` VARCHAR(20) NULL,
    `client_ref` VARCHAR(50) NULL,
    `remark` VARCHAR(512) NULL,
    `created_at` DATETIME(0) NULL,

    INDEX `carts_member_id_type_created_at_idx`(`member_id`, `type`, `created_at`),
    INDEX `carts_client_ref_idx`(`client_ref`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cart_value_added_services` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `cart_id` INTEGER NOT NULL,
    `service_id` INTEGER NOT NULL,
    `name_snapshot` VARCHAR(255) NOT NULL,
    `remark` VARCHAR(255) NULL,
    `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `qty` INTEGER NOT NULL DEFAULT 1,
    `fee` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `cart_value_added_services_cart_id_idx`(`cart_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

