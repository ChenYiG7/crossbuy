-- ============================================================================
-- 补充 T0：tid 家族统一显式 utf8mb4_general_ci（order 域）
--
-- ★ 为什么必须显式定（2026-10-14 实测本地 taotaro 副本 + 生产 dump）：
--     tid 家族旧库 collation **分两代**：
--       · dg_order.tid / dg_cart.tid / dg_examination_record.tid → utf8mb3_general_ci
--       · v2_platform_order_amount.tid                             → utf8mb4_unicode_ci
--     Prisma T0 生成的表级默认是 utf8mb4_unicode_ci，直接用它会有两个问题：
--       1. order_groups.tid 上有 UNIQUE（Q5 拍板的组表正本）——unicode_ci 会把
--          「全角/半角」「片假名/平假名」「全角空格 U+3000」视为等价，
--          与旧库 dg 家族（general_ci）的判重口径不一致，回填/双写时可能误撞唯一键；
--       2. tid 是**跨表同一业务键**（order_groups / examination_records / carts /
--          platform_trade_amounts 四张表都要按 tid JOIN/对账）——collation 不一致
--          直接报 Illegal mix of collations。
--     → 整个 tid 家族统一 general_ci（与 dg 家族逐字一致的判重口径，零行为变更）。
--
-- ★ 与 member.username 的关系：
--     同一套思路（docs/plans/00… 0001a），但**理由不同**：username 是为避免误并
--     真实用户；tid 是为跨表 JOIN 一致性 + 与旧库判重口径一致。
--
-- ★ 副作用与约束：
--   1. Prisma 不支持列级 collation → 本文件为**手工 SQL**，不属于「手改生成的 DDL」。
--   2. 改后 tid 列与其他 utf8mb4_unicode_ci 列混用时报 Illegal mix of collations，
--      故**禁止**把 tid 与普通字符串列（如 goods_name）做 JOIN/UNION 比较。
--   3. MODIFY 会保留 order_groups_tid_key UNIQUE 索引，唯一性判定随之变 general_ci。
--   4. platform_trade_amounts.tid 旧库是 unicode_ci——如生产库该表存在「仅大小写/全半角
--      不同」的两行 tid，MODIFY 后回填会撞唯一键（这正是我们想要的行为：立即暴露）。
--
-- ★ 幂等：collation 已一致时重复执行无副作用。
-- ============================================================================

ALTER TABLE order_groups
  MODIFY COLUMN `tid` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL;

ALTER TABLE examination_records
  MODIFY COLUMN `tid` VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL;

ALTER TABLE carts
  MODIFY COLUMN `tid` VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL;

ALTER TABLE platform_trade_amounts
  MODIFY COLUMN `tid` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;
