-- ============================================================================
-- 本地演练专用：从本地 taotaro 副本导入 send-order 域旧表到 crossbuy_dryrun
--
-- ⚠ 生产 T1 **不需要**本脚本：生产环境源表与目标表同库（taotaro），
--   回填脚本 0011/0012 直接用裸表名执行。本脚本仅为本机 FlyEnv 演练。
--
-- 做法（与 order 域 0006 一致）：
--   ① DROP + CREATE TABLE LIKE —— 从 taotaro 复制完全一致的结构（含 collation）
--   ② INSERT .. SELECT —— 跨库搬运数据
--   可反复执行（DROP 重置），无副作用。
--
-- 数据源实况（2026-10-15，本地 taotaro 副本）：
--   dg_sendorder 18,078 行（AUTO_INCREMENT 672,867；生产约 67 万）
--   dg_fapiao 371.8 万行 —— 本脚本**只导入 sid 命中本地 dg_sendorder 的子集**
--     （29,238 行 = JOIN member 后的回填目标；全量导入 371 万行对演练无收益）
--     ⚠ 生产 T1：dg_fapiao 446 万行按 fid 分片 + 短连接回填（隧道长连接不稳教训），
--       禁一次性大 INSERT；孤儿过滤同样靠 JOIN send_orders。
--   v2_sendorder_value_added_service 36 行（sid 无空值）
--   本地**不存在**（回填脚本对应段 PREPARE 条件跳过，生产有）：
--   v2_send_order_label / v2_send_order_invoice_event
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 运单主表
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS dg_sendorder;
CREATE TABLE dg_sendorder LIKE taotaro.dg_sendorder;
INSERT INTO dg_sendorder SELECT * FROM taotaro.dg_sendorder;

-- ---------------------------------------------------------------------------
-- 2. 运单增值服务收费
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS v2_sendorder_value_added_service;
CREATE TABLE v2_sendorder_value_added_service LIKE taotaro.v2_sendorder_value_added_service;
INSERT INTO v2_sendorder_value_added_service SELECT * FROM taotaro.v2_sendorder_value_added_service;

-- ---------------------------------------------------------------------------
-- 3. 发票（dg_fapiao）—— 只导 sid 命中本地 dg_sendorder 的子集（见头部说明）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS dg_fapiao;
CREATE TABLE dg_fapiao LIKE taotaro.dg_fapiao;
INSERT INTO dg_fapiao
SELECT f.* FROM taotaro.dg_fapiao f
JOIN taotaro.dg_sendorder s ON f.sid = s.sid;

-- ---------------------------------------------------------------------------
-- 4. 完事后校验（与 0013 的「前置检查」重复无妨）
-- ---------------------------------------------------------------------------
SELECT 'dg_sendorder' AS tbl, COUNT(*) AS rows_in_dryrun FROM dg_sendorder
UNION ALL SELECT 'v2_sendorder_value_added_service', COUNT(*) FROM v2_sendorder_value_added_service
UNION ALL SELECT 'dg_fapiao(subset)', COUNT(*) FROM dg_fapiao;
