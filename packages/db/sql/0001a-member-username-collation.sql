-- ============================================================================
-- 补充 T0：把 member.username 的排序规则显式定为 utf8mb4_general_ci
--
-- ★ 为什么必须显式定（2026-10-13 在 22,612 个真实用户名上实测）：
--     utf8mb4_general_ci（≈ 旧库 utf8_general_ci） →  8 个重名组
--     utf8mb4_unicode_ci（T0 生成 DDL 的表级默认） → 24 个重名组
--     utf8mb4_0900_ai_ci（MySQL 8 默认）          → 23 个
--     utf8mb4_bin（区分大小写）                    →  8 个，但破坏 ci 登录语义
--   unicode_ci 额外把「全角/半角」「片假名/平假名」「全角空格 U+3000」视为等价，多出 16 组。
--   这 16 组里有多对**不同人**：
--     · RYUJI：uid 1801 渡辺様（815 单 / ¥1489.01） vs uid 7874 深澤竜二（2 单）
--     · まつ ：uid 1996 松園様（100 单）           vs uid 21691 松岡司様（384 单）
--   强制折并会误伤真实用户 → 选与旧库**逐字一致**的 general_ci，零行为变更。
--
-- ★ 副作用与约束：
--   1. Prisma 不支持列级 collation → 本文件为**手工 SQL**，不属于「手改生成的 DDL」。
--   2. 改后 member.username 与其他 utf8mb4_unicode_ci 列混用时报 Illegal mix of collations，
--      故**禁止**把 username 与其他字符串列做 JOIN / UNION 比较；只与字面量/参数比较（安全）。
--   3. MODIFY 会保留 UNIQUE 索引，唯一性判定随之变为 general_ci（正是我们要的）。
--
-- ★ 幂等：collation 已一致时重复执行无副作用。
-- ============================================================================

ALTER TABLE member
  MODIFY COLUMN `username` VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL;
