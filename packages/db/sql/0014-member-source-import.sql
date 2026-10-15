-- ============================================================================
-- 本地演练专用（0014）：从本地 taotaro 副本导入 **member 域** 旧源表到 crossbuy_dryrun
--
-- ⚠ 生产 T1 **不需要**本脚本：生产环境源表与目标表同库（taotaro），
--   回填脚本 0002/0004 直接用裸表名执行。本脚本只为让本机演练库**可从零复现**——
--   前几轮 member 演练的旧表副本是手工建的，库一旦重建，③⑤ 就无从起跑（TODO #3g④）。
--
-- 命名/惯例对齐 `0006-order-source-import.sql`、`0010-send-order-source-import.sql`。
--
-- 做法：
--   ① DROP + `CREATE TABLE LIKE` —— 从 taotaro 复制**完全一致**的结构（含 collation）
--   ② INSERT .. SELECT —— 跨库搬运数据
--   可反复执行（DROP 重置），只写演练库，无副作用。
--
-- ⚠ 与 0006 的**唯一差异**：本机 `taotaro` 是**旧版 dump**（`taotaro.sql`，dg_users 仅 74 列），
--   而生产 `dg_users` 实为 **75 列**（2026-10-13 按线上 information_schema 核对，见
--   docs/plans/member-迁移与共存.md §修订）。`0002` 会读 `biz_code` → 本脚本在建表后用
--   information_schema 探测**补列**（NULL 默认，正好压测 0002 的 `COALESCE(NULLIF(...))` 兜底）。
--   ⇒ 生产没有这个问题；这条纯粹是「本机 dump 落后于生产」的补丁，别照抄到生产。
--
-- ⚠ 纪律：演练库里可能有真实账号结构，**禁导出、禁提交、禁写回任何源库**。
--
-- 覆盖表（15 张 = 0002 的 2 张核心 + 0004 的 13 张侧表源）：
--   dg_users · dg_address
--   v2_member_webhook · v2_member_webhook_delivery · v2_oauth_login · v2_oauth_taobao_global
--   v2_favorite · v2_favorite_category · v2_user_browse_history · v2_area
--   user_benefit_configs · user_benefits · user_operation_log
--   v2_personal_access_tokens · v2_open_api_idempotency
--
-- 执行顺序：0001 → 0001a → **0014** → 0002 → 0003 → 0004 → 0005
-- （0006 的 §0 会 TRUNCATE dg_users 再灌同一份数据，两者对 dg_users 等价；
--   只跑 order 域演练时可以跳过本脚本，但 0006 依赖 dg_users 存在。）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 核心两表
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS dg_users;
CREATE TABLE dg_users LIKE taotaro.dg_users;
INSERT INTO dg_users SELECT * FROM taotaro.dg_users;

-- 补列守卫（本机 dump 缺生产实有的 biz_code）
SET @s := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dg_users' AND COLUMN_NAME = 'biz_code') = 0,
  'ALTER TABLE dg_users ADD COLUMN biz_code VARCHAR(56) NULL DEFAULT NULL',
  'SELECT ''biz_code already present: skip ALTER'' AS drill_note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

DROP TABLE IF EXISTS dg_address;
CREATE TABLE dg_address LIKE taotaro.dg_address;
INSERT INTO dg_address SELECT * FROM taotaro.dg_address;

-- ---------------------------------------------------------------------------
-- 2. 侧表源表（13 张，字段与 0004 逐列同名，仅 uid → member_id）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS v2_member_webhook;
CREATE TABLE v2_member_webhook LIKE taotaro.v2_member_webhook;
INSERT INTO v2_member_webhook SELECT * FROM taotaro.v2_member_webhook;

DROP TABLE IF EXISTS v2_member_webhook_delivery;
CREATE TABLE v2_member_webhook_delivery LIKE taotaro.v2_member_webhook_delivery;
INSERT INTO v2_member_webhook_delivery SELECT * FROM taotaro.v2_member_webhook_delivery;

DROP TABLE IF EXISTS v2_oauth_login;
CREATE TABLE v2_oauth_login LIKE taotaro.v2_oauth_login;
INSERT INTO v2_oauth_login SELECT * FROM taotaro.v2_oauth_login;

DROP TABLE IF EXISTS v2_oauth_taobao_global;
CREATE TABLE v2_oauth_taobao_global LIKE taotaro.v2_oauth_taobao_global;
INSERT INTO v2_oauth_taobao_global SELECT * FROM taotaro.v2_oauth_taobao_global;

DROP TABLE IF EXISTS v2_favorite;
CREATE TABLE v2_favorite LIKE taotaro.v2_favorite;
INSERT INTO v2_favorite SELECT * FROM taotaro.v2_favorite;

DROP TABLE IF EXISTS v2_favorite_category;
CREATE TABLE v2_favorite_category LIKE taotaro.v2_favorite_category;
INSERT INTO v2_favorite_category SELECT * FROM taotaro.v2_favorite_category;

DROP TABLE IF EXISTS v2_user_browse_history;
CREATE TABLE v2_user_browse_history LIKE taotaro.v2_user_browse_history;
INSERT INTO v2_user_browse_history SELECT * FROM taotaro.v2_user_browse_history;

DROP TABLE IF EXISTS v2_area;
CREATE TABLE v2_area LIKE taotaro.v2_area;
INSERT INTO v2_area SELECT * FROM taotaro.v2_area;

DROP TABLE IF EXISTS user_benefit_configs;
CREATE TABLE user_benefit_configs LIKE taotaro.user_benefit_configs;
INSERT INTO user_benefit_configs SELECT * FROM taotaro.user_benefit_configs;

DROP TABLE IF EXISTS user_benefits;
CREATE TABLE user_benefits LIKE taotaro.user_benefits;
INSERT INTO user_benefits SELECT * FROM taotaro.user_benefits;

DROP TABLE IF EXISTS user_operation_log;
CREATE TABLE user_operation_log LIKE taotaro.user_operation_log;
INSERT INTO user_operation_log SELECT * FROM taotaro.user_operation_log;

DROP TABLE IF EXISTS v2_personal_access_tokens;
CREATE TABLE v2_personal_access_tokens LIKE taotaro.v2_personal_access_tokens;
INSERT INTO v2_personal_access_tokens SELECT * FROM taotaro.v2_personal_access_tokens;

DROP TABLE IF EXISTS v2_open_api_idempotency;
CREATE TABLE v2_open_api_idempotency LIKE taotaro.v2_open_api_idempotency;
INSERT INTO v2_open_api_idempotency SELECT * FROM taotaro.v2_open_api_idempotency;

-- ---------------------------------------------------------------------------
-- 3. 落地自检：15 张表行数（源 vs 演练副本，必须逐行相等）
--    任一行 actual <> source ⇒ 该表结构漂移（SELECT * 列数不等会先报错）或灌数中断。
-- ---------------------------------------------------------------------------
SELECT 'dg_users' AS tbl,
       (SELECT COUNT(*) FROM taotaro.dg_users) AS source_rows,
       (SELECT COUNT(*) FROM dg_users) AS drill_rows
UNION ALL SELECT 'dg_address',
       (SELECT COUNT(*) FROM taotaro.dg_address), (SELECT COUNT(*) FROM dg_address)
UNION ALL SELECT 'v2_member_webhook',
       (SELECT COUNT(*) FROM taotaro.v2_member_webhook), (SELECT COUNT(*) FROM v2_member_webhook)
UNION ALL SELECT 'v2_member_webhook_delivery',
       (SELECT COUNT(*) FROM taotaro.v2_member_webhook_delivery), (SELECT COUNT(*) FROM v2_member_webhook_delivery)
UNION ALL SELECT 'v2_oauth_login',
       (SELECT COUNT(*) FROM taotaro.v2_oauth_login), (SELECT COUNT(*) FROM v2_oauth_login)
UNION ALL SELECT 'v2_oauth_taobao_global',
       (SELECT COUNT(*) FROM taotaro.v2_oauth_taobao_global), (SELECT COUNT(*) FROM v2_oauth_taobao_global)
UNION ALL SELECT 'v2_favorite',
       (SELECT COUNT(*) FROM taotaro.v2_favorite), (SELECT COUNT(*) FROM v2_favorite)
UNION ALL SELECT 'v2_favorite_category',
       (SELECT COUNT(*) FROM taotaro.v2_favorite_category), (SELECT COUNT(*) FROM v2_favorite_category)
UNION ALL SELECT 'v2_user_browse_history',
       (SELECT COUNT(*) FROM taotaro.v2_user_browse_history), (SELECT COUNT(*) FROM v2_user_browse_history)
UNION ALL SELECT 'v2_area',
       (SELECT COUNT(*) FROM taotaro.v2_area), (SELECT COUNT(*) FROM v2_area)
UNION ALL SELECT 'user_benefit_configs',
       (SELECT COUNT(*) FROM taotaro.user_benefit_configs), (SELECT COUNT(*) FROM user_benefit_configs)
UNION ALL SELECT 'user_benefits',
       (SELECT COUNT(*) FROM taotaro.user_benefits), (SELECT COUNT(*) FROM user_benefits)
UNION ALL SELECT 'user_operation_log',
       (SELECT COUNT(*) FROM taotaro.user_operation_log), (SELECT COUNT(*) FROM user_operation_log)
UNION ALL SELECT 'v2_personal_access_tokens',
       (SELECT COUNT(*) FROM taotaro.v2_personal_access_tokens), (SELECT COUNT(*) FROM v2_personal_access_tokens)
UNION ALL SELECT 'v2_open_api_idempotency',
       (SELECT COUNT(*) FROM taotaro.v2_open_api_idempotency), (SELECT COUNT(*) FROM v2_open_api_idempotency);

-- 补列结果（应输出 1 行、has_biz_code = 1）
SELECT COUNT(*) AS has_biz_code
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dg_users' AND COLUMN_NAME = 'biz_code';
