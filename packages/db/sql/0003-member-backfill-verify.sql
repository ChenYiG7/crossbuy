-- ============================================================================
-- T1 回填一致性校验（**只读断言**，回填后必跑）
-- 用法：对每个 SELECT 看 result 列是否全 PASS（INFO 行只供人工判读）。
--
-- ★ 2026-10-15 重写组 A/B（TODO #3g②）：期望值一律**按当前源 + 映射表实时计算**，
--   禁把生产快照的数字写死进 expected。旧版把「8 组 / 8 改名 / 1 合并」硬编成常量，
--   在本地副本（taotaro 旧版 dump，5,021 用户、7 组重名、映射只覆盖 2 组）必然报
--   4 项 FAIL —— 那不是数据错，是**校验脚本自己在撒谎**（详见 docs/plans/03 §9.4）。
--   现在这四条变成：
--     A1 重名组数            → INFO（观察项，永不 FAIL）
--     A2 映射后仍撞车组数    → 必须 0（与 0002 §1b 守卫同口径）
--     A3/A4/A5 映射自洽性    → 必须 0（映射失效 / 规则不符 / 合并端悬空）
--     B6/B7 改名数与合并数    → expected 取自 `_t1_username_fix` / `_t1_username_merge`
--   即：期望值与回填**读同一份映射**，源变了期望值跟着变，不再需要人手改本文件。
--
-- 前置：映射表 `_t1_username_fix` / `_t1_username_merge` 由 `0002` §1 建立并**保留**
--       （升为实体表正是为了本脚本能跨会话读到；临时表对本会话外不可见）。
--       若目标库被重建过而没重跑 0002，本脚本会在 A2 处报「table doesn't exist」——
--       这是预期行为（说明回填还没跑），不是本脚本的缺陷。
--
-- ⚠ collation：源列 `dg_users.uname` 是 utf8mb3_general_ci（折叠假名/片假名），
--   目标列 `member.username` 是 utf8mb4_general_ci（不折叠，见 0001a）。
--   判「目标名撞车」必须先 `CAST(... AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci`
--   （按源 collation 判会误报）；跨 mb3/mb4 直接比较会报 ERROR 1253/1267。
-- ⚠ 本机 mysql CLI 默认 gbk，跑本脚本加 `--default-character-set=utf8mb4`。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 组 A：回填**前置/映射自洽**断言（映射表就位后即可跑；回填前跑一次、回填后再跑一次）
-- ---------------------------------------------------------------------------
SELECT 'A1 源(dg_users) trim+lower 重名组数' AS check_name,
       '-' AS expected, s.cnt AS actual, 'INFO' AS result
FROM (
  SELECT COUNT(*) AS cnt FROM (
    SELECT LOWER(TRIM(uname)) AS n FROM dg_users
    WHERE uname IS NOT NULL AND TRIM(uname) <> ''
    GROUP BY LOWER(TRIM(uname)) HAVING COUNT(*) > 1) d
) s
UNION ALL
SELECT 'A1b 重名组涉及账号数', '-', s.cnt, 'INFO'
FROM (
  SELECT COALESCE(SUM(c), 0) AS cnt FROM (
    SELECT COUNT(*) AS c FROM dg_users
    WHERE uname IS NOT NULL AND TRIM(uname) <> ''
    GROUP BY LOWER(TRIM(uname)) HAVING COUNT(*) > 1) g
) s
UNION ALL
SELECT 'A1c 消歧映射条数 / 合并映射条数', '-', CONCAT(s.f, ' / ', m.g), 'INFO'
FROM (SELECT COUNT(*) AS f FROM _t1_username_fix) s
CROSS JOIN (SELECT COUNT(*) AS g FROM _t1_username_merge) m
UNION ALL
-- ★ 与 0002 §1b 守卫**同一条表达式**：映射应用后，目标 username 在目标列 collation
--   下必须全局唯一。非 0 = 源里长出了映射没覆盖的重名 → 回填会静默吞账号，禁跑。
SELECT 'A2 映射后目标名仍撞车组数(必须 0)', 0, s.cnt, IF(s.cnt = 0, 'PASS', 'FAIL')
FROM (
  SELECT COUNT(*) AS cnt FROM (
    SELECT CAST(COALESCE(f.new_username, NULLIF(TRIM(u.uname), ''), CONCAT('user_', u.uid))
                 AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci AS t
    FROM dg_users u
    LEFT JOIN _t1_username_fix f ON f.uid = u.uid
    GROUP BY t HAVING COUNT(*) > 1) d
) s
UNION ALL
-- 映射陈旧检查：条目对应的 uid 必须还在源里，且它**确实属于某个重名组**
-- （若那人后来改了用户名，映射就成了无谓改名 → 需要人工确认而不是默默执行）
SELECT 'A3 映射失效条数(uid 不存在或已不重名)', 0, s.cnt, IF(s.cnt = 0, 'PASS', 'FAIL')
FROM (
  SELECT COUNT(*) AS cnt
  FROM _t1_username_fix f
  LEFT JOIN dg_users u ON u.uid = f.uid
  LEFT JOIN (
    SELECT LOWER(TRIM(uname)) AS n FROM dg_users
    WHERE uname IS NOT NULL AND TRIM(uname) <> ''
    GROUP BY LOWER(TRIM(uname)) HAVING COUNT(*) > 1) d ON d.n = LOWER(TRIM(u.uname))
  WHERE u.uid IS NULL OR d.n IS NULL
) s
UNION ALL
-- 改名规则（docs/plans/02）：新名必须 = TRIM(原名) + '_' + uid。
-- 按**目标索引口径** utf8mb4_general_ci 比较（大小写差异不影响唯一性判定，故不算违例）
SELECT 'A4 改名规则违例条数(<> 原名_uid)', 0, s.cnt, IF(s.cnt = 0, 'PASS', 'FAIL')
FROM (
  SELECT COUNT(*) AS cnt
  FROM _t1_username_fix f
  JOIN dg_users u ON u.uid = f.uid
  WHERE CAST(f.new_username AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci
        <> CAST(CONCAT(TRIM(u.uname), '_', f.uid) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci
) s
UNION ALL
SELECT 'A5 合并映射悬空条数(uid 或 target 不在源)', 0, s.cnt, IF(s.cnt = 0, 'PASS', 'FAIL')
FROM (
  SELECT COUNT(*) AS cnt
  FROM _t1_username_merge g
  LEFT JOIN dg_users u ON u.uid = g.uid
  LEFT JOIN dg_users t ON t.uid = g.target_uid
  WHERE u.uid IS NULL OR t.uid IS NULL
) s;

-- ---------------------------------------------------------------------------
-- 组 B：回填**后**断言
-- ---------------------------------------------------------------------------
SELECT 'B1 member 行数 = dg_users 行数' AS check_name,
       s.src AS expected, t.cnt AS actual, IF(t.cnt = s.src, 'PASS', 'FAIL') AS result
FROM (SELECT COUNT(*) AS src FROM dg_users) s
CROSS JOIN (SELECT COUNT(*) AS cnt FROM member) t
UNION ALL
-- ★ 2026-10-15（#3g③）：期望值改为「源中**父会员存在**的地址行数」，不再是 dg_address 全量
--   （0002 §4 现在 JOIN member 过滤孤儿，全量口径会把正常过滤误判成 FAIL）
SELECT 'B2 member_address 行数 = 源中非孤儿地址行数', s.src, t.cnt, IF(t.cnt = s.src, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS src FROM dg_address a JOIN member m ON m.id = a.uid) s
CROSS JOIN (SELECT COUNT(*) AS cnt FROM member_address) t
UNION ALL
SELECT 'B3 member.id 悬空(不在 dg_users)', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM member m
      LEFT JOIN dg_users u ON u.uid = m.id WHERE u.uid IS NULL) t
UNION ALL
SELECT 'B4 dg_users 未回填(uid 不在 member)', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM dg_users u
      LEFT JOIN member m ON m.id = u.uid WHERE m.id IS NULL) t
UNION ALL
SELECT 'B5 用户名残留首尾空格', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM member WHERE username <> TRIM(username)
        OR CHAR_LENGTH(username) <> CHAR_LENGTH(TRIM(username))) t
UNION ALL
-- ★ 期望值取自映射表（与 0002 读同一份），不再写死 8
SELECT 'B6 自动改名账号数 = 映射条数', s.src, t.cnt, IF(t.cnt = s.src, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS src FROM _t1_username_fix) s
CROSS JOIN (SELECT COUNT(*) AS cnt FROM member WHERE username_auto_renamed = 1) t
UNION ALL
-- ★ 同上，不再写死 1
SELECT 'B7 合并标记数 = 合并映射条数', s.src, t.cnt, IF(t.cnt = s.src, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS src FROM _t1_username_merge) s
CROSS JOIN (SELECT COUNT(*) AS cnt FROM member WHERE merged_into_id IS NOT NULL) t
UNION ALL
SELECT 'B8 余额不一致(balance<>money)', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM member m JOIN dg_users u ON u.uid = m.id
      WHERE COALESCE(m.balance, 0) <> COALESCE(u.money, 0)) t
UNION ALL
SELECT 'B9 created_at 与 regtime 不一致', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM member m JOIN dg_users u ON u.uid = m.id
      WHERE u.regtime > 0 AND m.created_at <> FROM_UNIXTIME(u.regtime)) t
UNION ALL
SELECT 'B10 密码算法标记(应全 md5)', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM member WHERE password_algo <> 'md5') t
UNION ALL
SELECT 'B11 AUTO_INCREMENT 已顶高(member)', 'PASS',
       CONCAT('auto_inc=', COALESCE(s.ai, -1), ' max_id=', s.mx),
       IF(COALESCE(s.ai, 0) > s.mx, 'PASS', 'FAIL')
FROM (
  SELECT (SELECT AUTO_INCREMENT FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member') AS ai,
         COALESCE((SELECT MAX(id) FROM member), 0) AS mx
) s
UNION ALL
-- ★ #3g③ 后本项从「INF/WARN」升级为**硬断言**：回填已过滤孤儿，此处必须 0
SELECT 'B12 member_address.member_id 悬空', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt FROM member_address a
      LEFT JOIN member m ON m.id = a.member_id WHERE m.id IS NULL) t
UNION ALL
-- 被 JOIN 过滤掉的孤儿地址数：非 0 是**正常**的（旧库允许地址挂死账号），
-- 但要留个数供 T3 旧表降级前评估；若它等于 dg_address 全量则说明 §2 没跑完。
SELECT 'B13 源中父会员不存在的地址(已过滤)', '-', t.cnt, 'INFO'
FROM (SELECT COUNT(*) AS cnt FROM dg_address a
      LEFT JOIN member m ON m.id = a.uid WHERE m.id IS NULL) t
UNION ALL
SELECT 'B14 映射账号在目标表确已改名', 0, t.cnt, IF(t.cnt = 0, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS cnt
      FROM _t1_username_fix f JOIN member m ON m.id = f.uid
      WHERE CAST(m.username AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci
            <> CAST(f.new_username AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci) t;

-- ---------------------------------------------------------------------------
-- 组 C：抽查明细（人工核对用）
-- ---------------------------------------------------------------------------
SELECT 'C1 消歧账号明细' AS section;
SELECT m.id, m.username, m.username_original, m.username_auto_renamed, m.merged_into_id
FROM member m
WHERE m.username_auto_renamed = 1 OR m.merged_into_id IS NOT NULL
ORDER BY m.id;

SELECT 'C2 映射表 vs 目标表逐条对照（A4/B14 报 FAIL 时用来定位是哪一条）' AS section;
SELECT f.uid, f.new_username, m.username AS actual_username, m.username_original
FROM _t1_username_fix f LEFT JOIN member m ON m.id = f.uid ORDER BY f.uid;

SELECT 'C3 抽样 10 行（时间/金额转换）' AS section;
SELECT m.id, m.username, m.balance, u.money AS old_money,
       m.created_at, FROM_UNIXTIME(u.regtime) AS old_regtime_dt,
       m.password_algo, CHAR_LENGTH(m.password_hash) AS hash_len
FROM member m JOIN dg_users u ON u.uid = m.id ORDER BY m.id LIMIT 10;
