-- ============================================================================
-- 本地演练专用：从本地 taotaro 副本导入 order 域旧表到 crossbuy_dryrun
--
-- ⚠ 生产 T1 **不需要**本脚本：生产环境源表与目标表同库（taotaro），
--   回填脚本 0007/0008 直接用裸表名执行。本脚本仅为本机 FlyEnv 演练：
--   crossbuy_dryrun 里此前只有 member 域的旧表副本，order 域旧表需先落地。
--
-- 做法（与 member 域演练一致）：
--   ① DROP + CREATE TABLE LIKE —— 从 taotaro 复制**完全一致**的结构（含 collation）
--   ② INSERT .. SELECT —— 跨库搬运数据
--   可反复执行（DROP 重置），无副作用。
--
-- 数据源实况（2026-10-14，本地 taotaro 副本）：
--   dg_order 328,479 行 / dg_cart 79,088 / dg_yunjiao 177,921 /
--   dg_imporder 69,903 + detail 179,239 / dg_invalid_order 143,932 /
--   dg_examination_record 285,065 + relation 316,032 / dg_order_split 14,624 /
--   v2_ecommerce_order 121 + item 230 / shop 30 / product 8,154 / sku 108,889 /
--   v2_order_detail 187 / v2_order_auto_created 34 / v2_platform_sub_account 167 /
--   v2_order_value_added_service 79 / v2_cart_value_added_service 74
--   本地**不存在**（回填脚本对应段跳过，生产有）：dg_inquiry_order(_item) /
--   v2_order_client_ref / v2_platform_order_amount
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. dg_users 刷新：dryrun 现有 6 行模拟数据（uid 1001-2001），TRUNCATE 后导真实
--    （member 回填脚本 0002 幂等，重跑即用真实数据重建 member 表）
--    ⚠ dryrun 的 dg_users 比 taotaro 源多一列 biz_code（member 演练遗留），
--      禁 SELECT * —— 用显式列清单导入，biz_code 留空（0002 的 COALESCE 兜底）
-- ---------------------------------------------------------------------------
TRUNCATE TABLE dg_users;
INSERT INTO dg_users (`uid`,`uname`,`password`,`email`,`tname`,`utype`,`sex`,`xz`,`tel`,`zip`,`card`,`address`,`qq`,`msn`,`country`,`city`,`face`,`scores`,`money`,`regip`,`regtime`,`reg_extra`,`validity`,`loginip`,`logintime`,`activekey`,`state`,`memberid`,`remark`,`fb`,`dfflag`,`dffee`,`floatrate`,`csvupflag`,`dfsendaddress`,`dfsendtel`,`dfsendname`,`lastordertime`,`last_balance_changed_at`,`login_limit_warning`,`orderenable`,`stoptime`,`regtype`,`comname`,`comengname`,`commanager`,`commanagereng`,`compost`,`comptel`,`comaddress`,`comaddresseng`,`comzip`,`realtimeaccount`,`line`,`wechat`,`usetype`,`tag`,`prebuyfeq`,`prebuyamt`,`enname`,`monpayamt`,`shopname`,`shopurl`,`combusnum`,`apitoken`,`tokenexpiretime`,`mail_frequency`,`email_subscribe_status`,`cc_emails`,`remember_token`,`stores_free_days`,`stores_warn_days`,`belong_company`,`origin_package_choice`)
SELECT `uid`,`uname`,`password`,`email`,`tname`,`utype`,`sex`,`xz`,`tel`,`zip`,`card`,`address`,`qq`,`msn`,`country`,`city`,`face`,`scores`,`money`,`regip`,`regtime`,`reg_extra`,`validity`,`loginip`,`logintime`,`activekey`,`state`,`memberid`,`remark`,`fb`,`dfflag`,`dffee`,`floatrate`,`csvupflag`,`dfsendaddress`,`dfsendtel`,`dfsendname`,`lastordertime`,`last_balance_changed_at`,`login_limit_warning`,`orderenable`,`stoptime`,`regtype`,`comname`,`comengname`,`commanager`,`commanagereng`,`compost`,`comptel`,`comaddress`,`comaddresseng`,`comzip`,`realtimeaccount`,`line`,`wechat`,`usetype`,`tag`,`prebuyfeq`,`prebuyamt`,`enname`,`monpayamt`,`shopname`,`shopurl`,`combusnum`,`apitoken`,`tokenexpiretime`,`mail_frequency`,`email_subscribe_status`,`cc_emails`,`remember_token`,`stores_free_days`,`stores_warn_days`,`belong_company`,`origin_package_choice` FROM taotaro.dg_users;

-- ---------------------------------------------------------------------------
-- 1. order 域核心源表
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS dg_order;
CREATE TABLE dg_order LIKE taotaro.dg_order;
INSERT INTO dg_order SELECT * FROM taotaro.dg_order;

DROP TABLE IF EXISTS dg_cart;
CREATE TABLE dg_cart LIKE taotaro.dg_cart;
INSERT INTO dg_cart SELECT * FROM taotaro.dg_cart;

DROP TABLE IF EXISTS dg_yunjiao;
CREATE TABLE dg_yunjiao LIKE taotaro.dg_yunjiao;
INSERT INTO dg_yunjiao SELECT * FROM taotaro.dg_yunjiao;

DROP TABLE IF EXISTS dg_imporder;
CREATE TABLE dg_imporder LIKE taotaro.dg_imporder;
INSERT INTO dg_imporder SELECT * FROM taotaro.dg_imporder;

DROP TABLE IF EXISTS dg_imporder_detail;
CREATE TABLE dg_imporder_detail LIKE taotaro.dg_imporder_detail;
INSERT INTO dg_imporder_detail SELECT * FROM taotaro.dg_imporder_detail;

DROP TABLE IF EXISTS dg_invalid_order;
CREATE TABLE dg_invalid_order LIKE taotaro.dg_invalid_order;
INSERT INTO dg_invalid_order SELECT * FROM taotaro.dg_invalid_order;

DROP TABLE IF EXISTS dg_examination_record;
CREATE TABLE dg_examination_record LIKE taotaro.dg_examination_record;
INSERT INTO dg_examination_record SELECT * FROM taotaro.dg_examination_record;

DROP TABLE IF EXISTS relation_order_and_examination_record;
CREATE TABLE relation_order_and_examination_record LIKE taotaro.relation_order_and_examination_record;
INSERT INTO relation_order_and_examination_record SELECT * FROM taotaro.relation_order_and_examination_record;

DROP TABLE IF EXISTS dg_order_split;
CREATE TABLE dg_order_split LIKE taotaro.dg_order_split;
INSERT INTO dg_order_split SELECT * FROM taotaro.dg_order_split;

-- ---------------------------------------------------------------------------
-- 2. 平台电商链路源表
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS v2_order_detail;
CREATE TABLE v2_order_detail LIKE taotaro.v2_order_detail;
INSERT INTO v2_order_detail SELECT * FROM taotaro.v2_order_detail;

DROP TABLE IF EXISTS v2_order_auto_created;
CREATE TABLE v2_order_auto_created LIKE taotaro.v2_order_auto_created;
INSERT INTO v2_order_auto_created SELECT * FROM taotaro.v2_order_auto_created;

DROP TABLE IF EXISTS v2_platform_sub_account;
CREATE TABLE v2_platform_sub_account LIKE taotaro.v2_platform_sub_account;
INSERT INTO v2_platform_sub_account SELECT * FROM taotaro.v2_platform_sub_account;

DROP TABLE IF EXISTS v2_ecommerce_order;
CREATE TABLE v2_ecommerce_order LIKE taotaro.v2_ecommerce_order;
INSERT INTO v2_ecommerce_order SELECT * FROM taotaro.v2_ecommerce_order;

DROP TABLE IF EXISTS v2_ecommerce_order_item;
CREATE TABLE v2_ecommerce_order_item LIKE taotaro.v2_ecommerce_order_item;
INSERT INTO v2_ecommerce_order_item SELECT * FROM taotaro.v2_ecommerce_order_item;

DROP TABLE IF EXISTS v2_ecommerce_shop;
CREATE TABLE v2_ecommerce_shop LIKE taotaro.v2_ecommerce_shop;
INSERT INTO v2_ecommerce_shop SELECT * FROM taotaro.v2_ecommerce_shop;

DROP TABLE IF EXISTS v2_ecommerce_product;
CREATE TABLE v2_ecommerce_product LIKE taotaro.v2_ecommerce_product;
INSERT INTO v2_ecommerce_product SELECT * FROM taotaro.v2_ecommerce_product;

DROP TABLE IF EXISTS v2_ecommerce_product_sku;
CREATE TABLE v2_ecommerce_product_sku LIKE taotaro.v2_ecommerce_product_sku;
INSERT INTO v2_ecommerce_product_sku SELECT * FROM taotaro.v2_ecommerce_product_sku;

DROP TABLE IF EXISTS v2_relation_ecommerce_product_sku_and_order;
CREATE TABLE v2_relation_ecommerce_product_sku_and_order LIKE taotaro.v2_relation_ecommerce_product_sku_and_order;
INSERT INTO v2_relation_ecommerce_product_sku_and_order SELECT * FROM taotaro.v2_relation_ecommerce_product_sku_and_order;

-- ---------------------------------------------------------------------------
-- 3. 增值服务收费源表
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS v2_order_value_added_service;
CREATE TABLE v2_order_value_added_service LIKE taotaro.v2_order_value_added_service;
INSERT INTO v2_order_value_added_service SELECT * FROM taotaro.v2_order_value_added_service;

DROP TABLE IF EXISTS v2_cart_value_added_service;
CREATE TABLE v2_cart_value_added_service LIKE taotaro.v2_cart_value_added_service;
INSERT INTO v2_cart_value_added_service SELECT * FROM taotaro.v2_cart_value_added_service;

-- ---------------------------------------------------------------------------
-- 4. 完事后校验（与 0009 的「前置检查」重复无妨）
-- ---------------------------------------------------------------------------
SELECT 'dg_order' AS tbl, COUNT(*) AS rows_in_dryrun FROM dg_order
UNION ALL SELECT 'dg_cart', COUNT(*) FROM dg_cart
UNION ALL SELECT 'dg_yunjiao', COUNT(*) FROM dg_yunjiao
UNION ALL SELECT 'dg_users', COUNT(*) FROM dg_users
UNION ALL SELECT 'dg_imporder', COUNT(*) FROM dg_imporder
UNION ALL SELECT 'dg_imporder_detail', COUNT(*) FROM dg_imporder_detail
UNION ALL SELECT 'dg_invalid_order', COUNT(*) FROM dg_invalid_order
UNION ALL SELECT 'dg_examination_record', COUNT(*) FROM dg_examination_record
UNION ALL SELECT 'relation_order_and_examination_record', COUNT(*) FROM relation_order_and_examination_record
UNION ALL SELECT 'dg_order_split', COUNT(*) FROM dg_order_split
UNION ALL SELECT 'v2_order_detail', COUNT(*) FROM v2_order_detail
UNION ALL SELECT 'v2_order_auto_created', COUNT(*) FROM v2_order_auto_created
UNION ALL SELECT 'v2_platform_sub_account', COUNT(*) FROM v2_platform_sub_account
UNION ALL SELECT 'v2_ecommerce_order', COUNT(*) FROM v2_ecommerce_order
UNION ALL SELECT 'v2_ecommerce_order_item', COUNT(*) FROM v2_ecommerce_order_item
UNION ALL SELECT 'v2_ecommerce_shop', COUNT(*) FROM v2_ecommerce_shop
UNION ALL SELECT 'v2_ecommerce_product', COUNT(*) FROM v2_ecommerce_product
UNION ALL SELECT 'v2_ecommerce_product_sku', COUNT(*) FROM v2_ecommerce_product_sku
UNION ALL SELECT 'v2_relation_ecommerce_product_sku_and_order', COUNT(*) FROM v2_relation_ecommerce_product_sku_and_order
UNION ALL SELECT 'v2_order_value_added_service', COUNT(*) FROM v2_order_value_added_service
UNION ALL SELECT 'v2_cart_value_added_service', COUNT(*) FROM v2_cart_value_added_service;
