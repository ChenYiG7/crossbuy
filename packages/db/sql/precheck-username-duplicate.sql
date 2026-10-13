-- ============================================================================
-- Q4 前置核查：dg_users.uname 重名检查（**只读**，在旧库执行）
--
-- 背景：新表 `member.username` 加了 UNIQUE，但旧表 `dg_users.uname` 只有普通索引，
--       允许重名。**有重名则不能直接上唯一约束**，必须先人工消歧。
-- 执行：在旧库（taotaro）上以只读方式跑；结果交业务确认后才允许建新表。
-- 纪律：本文件只含 SELECT，禁含任何 DML/DDL（旧库只读）。
-- ============================================================================

-- ① 总览：重名组数 + 被波及账号数（期望 0 / 0）
SELECT
  COUNT(*)                                   AS duplicate_group_count,
  COALESCE(SUM(cnt), 0)                      AS affected_account_count,
  COALESCE(MAX(cnt), 0)                      AS max_same_name
FROM (
  SELECT uname, COUNT(*) AS cnt
  FROM dg_users
  GROUP BY uname
  HAVING cnt > 1
) t;

-- ② 重名明细（逐组列出 uid，供人工消歧）
SELECT
  uname,
  COUNT(*)                                  AS cnt,
  GROUP_CONCAT(uid ORDER BY uid)            AS uids,
  GROUP_CONCAT(email ORDER BY uid SEPARATOR ' | ') AS emails,
  GROUP_CONCAT(state ORDER BY uid)          AS states,
  GROUP_CONCAT(regtime ORDER BY uid)        AS regtimes
FROM dg_users
GROUP BY uname
HAVING cnt > 1
ORDER BY cnt DESC, uname;

-- ③ 空 / 空白用户名（也是唯一约束的障碍）
SELECT
  SUM(uname IS NULL)        AS null_name,
  SUM(TRIM(uname) = '')     AS blank_name,
  COUNT(*)                  AS total_rows
FROM dg_users;

-- ④ 大小写/前后空格归并后会撞车的（ci 排序下 GROUP BY 已覆盖大小写；
--    这里额外暴露前后空格问题）
SELECT
  TRIM(uname)               AS normalized,
  COUNT(DISTINCT uname)     AS variant_count,
  COUNT(*)                  AS cnt,
  GROUP_CONCAT(DISTINCT uname SEPARATOR ' | ') AS variants,
  GROUP_CONCAT(uid ORDER BY uid)               AS uids
FROM dg_users
WHERE uname IS NOT NULL AND TRIM(uname) <> ''
GROUP BY TRIM(uname)
HAVING cnt > 1
ORDER BY cnt DESC;

-- ⑤ （可选）email 重复情况——若未来也想给 email 加唯一约束，先看现状
SELECT
  email,
  COUNT(*)                  AS cnt,
  GROUP_CONCAT(uid ORDER BY uid) AS uids
FROM dg_users
WHERE email IS NOT NULL AND TRIM(email) <> ''
GROUP BY email
HAVING cnt > 1
ORDER BY cnt DESC
LIMIT 50;
