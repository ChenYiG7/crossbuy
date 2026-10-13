-- ============================================================================
-- T1 回填一致性校验（**只读断言**，回填后必跑）
-- 用法：对每个 SELECT 看 result 列是否全 PASS。
-- 前置：建议在回填前也跑一遍第 1 组（应为「旧库重名数 = 0 或 = 已消歧数」）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 组 A：回填**前置**断言（回填前跑；确认消歧映射能兜住所有重名）
-- ---------------------------------------------------------------------------
SELECT 'A1 旧库(ci+trim)重名组数' AS check_name, 8 AS expected,
       (SELECT COUNT(*) FROM (
          SELECT LOWER(TRIM(uname)) FROM dg_users
          WHERE uname IS NOT NULL AND TRIM(uname) <> ''
          GROUP BY LOWER(TRIM(uname)) HAVING COUNT(*) > 1) t) AS actual,
       IF((SELECT COUNT(*) FROM (
          SELECT LOWER(TRIM(uname)) FROM dg_users
          WHERE uname IS NOT NULL AND TRIM(uname) <> ''
          GROUP BY LOWER(TRIM(uname)) HAVING COUNT(*) > 1) t) = 8, 'PASS', 'FAIL') AS result
UNION ALL
SELECT 'A2 消歧映射条数(=8改名)' AS check_name, 8 AS expected,
       (SELECT COUNT(*) FROM (
          SELECT 4110 UNION ALL SELECT 6685 UNION ALL SELECT 15274 UNION ALL SELECT 4018
          UNION ALL SELECT 1858 UNION ALL SELECT 18105 UNION ALL SELECT 3767 UNION ALL SELECT 4056) t) AS actual,
       IF((SELECT COUNT(*) FROM (
          SELECT 4110 UNION ALL SELECT 6685 UNION ALL SELECT 15274 UNION ALL SELECT 4018
          UNION ALL SELECT 1858 UNION ALL SELECT 18105 UNION ALL SELECT 3767 UNION ALL SELECT 4056) t) = 8, 'PASS', 'FAIL') AS result
UNION ALL
SELECT 'A3 消歧后旧名→新名唯一(无残留撞车)' AS check_name, 0 AS expected,
       (SELECT COUNT(*) FROM (
          SELECT COALESCE(f.new_username, NULLIF(TRIM(u.uname),''), CONCAT('user_',u.uid)) AS uname_eff
          FROM dg_users u LEFT JOIN (
            SELECT 4110 AS uid, 'A1a1_4110' AS new_username
            UNION ALL SELECT 6685, 'crisis0821_6685'
            UNION ALL SELECT 15274, 'Haru0128_15274'
            UNION ALL SELECT 4018, 'longtai_4018'
            UNION ALL SELECT 1858, 'megutoami_1858'
            UNION ALL SELECT 18105, 'nr7shopping_18105'
            UNION ALL SELECT 3767, 'PEYANG_3767'
            UNION ALL SELECT 4056, 'shkomatsuzaki_4056') f ON f.uid = u.uid
          GROUP BY uname_eff HAVING COUNT(*) > 1) t) AS actual,
       IF((SELECT COUNT(*) FROM (
          SELECT COALESCE(f.new_username, NULLIF(TRIM(u.uname),''), CONCAT('user_',u.uid)) AS uname_eff
          FROM dg_users u LEFT JOIN (
            SELECT 4110 AS uid, 'A1a1_4110' AS new_username
            UNION ALL SELECT 6685, 'crisis0821_6685'
            UNION ALL SELECT 15274, 'Haru0128_15274'
            UNION ALL SELECT 4018, 'longtai_4018'
            UNION ALL SELECT 1858, 'megutoami_1858'
            UNION ALL SELECT 18105, 'nr7shopping_18105'
            UNION ALL SELECT 3767, 'PEYANG_3767'
            UNION ALL SELECT 4056, 'shkomatsuzaki_4056') f ON f.uid = u.uid
          GROUP BY uname_eff HAVING COUNT(*) > 1) t) = 0, 'PASS', 'FAIL') AS result;

-- ---------------------------------------------------------------------------
-- 组 B：回填**后**断言
-- ---------------------------------------------------------------------------
SELECT 'B1 member 行数 = dg_users 行数' AS check_name,
       (SELECT COUNT(*) FROM dg_users) AS expected, (SELECT COUNT(*) FROM member) AS actual,
       IF((SELECT COUNT(*) FROM member) = (SELECT COUNT(*) FROM dg_users), 'PASS', 'FAIL') AS result
UNION ALL
SELECT 'B2 member_address 行数 = dg_address 行数',
       (SELECT COUNT(*) FROM dg_address), (SELECT COUNT(*) FROM member_address),
       IF((SELECT COUNT(*) FROM member_address) = (SELECT COUNT(*) FROM dg_address), 'PASS', 'FAIL')
UNION ALL
SELECT 'B3 member.id 悬空(不在 dg_users)',
       0, (SELECT COUNT(*) FROM member m LEFT JOIN dg_users u ON u.uid = m.id WHERE u.uid IS NULL),
       IF((SELECT COUNT(*) FROM member m LEFT JOIN dg_users u ON u.uid = m.id WHERE u.uid IS NULL) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'B4 dg_users 未回填(uid 不在 member)',
       0, (SELECT COUNT(*) FROM dg_users u LEFT JOIN member m ON m.id = u.uid WHERE m.id IS NULL),
       IF((SELECT COUNT(*) FROM dg_users u LEFT JOIN member m ON m.id = u.uid WHERE m.id IS NULL) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'B5 用户名残留首尾空格',
       0, (SELECT COUNT(*) FROM member WHERE username <> TRIM(username)
             OR CHAR_LENGTH(username) <> CHAR_LENGTH(TRIM(username))),
       IF((SELECT COUNT(*) FROM member WHERE username <> TRIM(username)
             OR CHAR_LENGTH(username) <> CHAR_LENGTH(TRIM(username))) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'B6 自动改名账号数',
       8, (SELECT COUNT(*) FROM member WHERE username_auto_renamed = 1),
       IF((SELECT COUNT(*) FROM member WHERE username_auto_renamed = 1) = 8, 'PASS', 'FAIL')
UNION ALL
SELECT 'B7 合并标记数(merged_into_id)',
       1, (SELECT COUNT(*) FROM member WHERE merged_into_id IS NOT NULL),
       IF((SELECT COUNT(*) FROM member WHERE merged_into_id IS NOT NULL) = 1, 'PASS', 'FAIL')
UNION ALL
SELECT 'B8 余额不一致(balance<>money)',
       0, (SELECT COUNT(*) FROM member m JOIN dg_users u ON u.uid = m.id
             WHERE COALESCE(m.balance,0) <> COALESCE(u.money,0)),
       IF((SELECT COUNT(*) FROM member m JOIN dg_users u ON u.uid = m.id
             WHERE COALESCE(m.balance,0) <> COALESCE(u.money,0)) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'B9 created_at 与 regtime 不一致',
       0, (SELECT COUNT(*) FROM member m JOIN dg_users u ON u.uid = m.id
             WHERE u.regtime > 0 AND m.created_at <> FROM_UNIXTIME(u.regtime)),
       IF((SELECT COUNT(*) FROM member m JOIN dg_users u ON u.uid = m.id
             WHERE u.regtime > 0 AND m.created_at <> FROM_UNIXTIME(u.regtime)) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'B10 密码算法标记(应全 md5)',
       0, (SELECT COUNT(*) FROM member WHERE password_algo <> 'md5'),
       IF((SELECT COUNT(*) FROM member WHERE password_algo <> 'md5') = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'B11 AUTO_INCREMENT 已顶高(member)',
       'PASS',
       CONCAT('auto_inc=', COALESCE((SELECT AUTO_INCREMENT FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='member'), -1),
              ' max_id=', (SELECT COALESCE(MAX(id),0) FROM member)),
       IF(COALESCE((SELECT AUTO_INCREMENT FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='member'), 0) > (SELECT COALESCE(MAX(id),0) FROM member),
          'PASS', 'FAIL')
UNION ALL
SELECT 'B12 member_address.member_id 悬空',
       0, (SELECT COUNT(*) FROM member_address a LEFT JOIN member m ON m.id = a.member_id WHERE m.id IS NULL),
       IF((SELECT COUNT(*) FROM member_address a LEFT JOIN member m ON m.id = a.member_id WHERE m.id IS NULL) = 0, 'INF', 'WARN');

-- ---------------------------------------------------------------------------
-- 组 C：抽查明细（人工核对用）
-- ---------------------------------------------------------------------------
SELECT 'C1 消歧账号明细' AS section;
SELECT id, username, username_original, username_auto_renamed, merged_into_id
FROM member WHERE username_auto_renamed = 1 OR merged_into_id IS NOT NULL ORDER BY id;

SELECT 'C2 抽样 10 行（时间/金额转换）' AS section;
SELECT m.id, m.username, m.balance, u.money AS old_money,
       m.created_at, FROM_UNIXTIME(u.regtime) AS old_regtime_dt,
       m.password_algo, CHAR_LENGTH(m.password_hash) AS hash_len
FROM member m JOIN dg_users u ON u.uid = m.id ORDER BY m.id LIMIT 10;
