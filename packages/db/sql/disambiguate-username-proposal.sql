-- ============================================================================
-- Q4 消歧建议：为重名账号生成「保留 / 改名」建议（**只读**，在旧库执行）
--
-- 目的：为 T1 回填到 `member.username`（UNIQUE）做准备 —— 有重名即回填失败。
-- 依据：旧库排序规则 utf8_general_ci（大小写 + **尾部空格**不敏感）；
--       新表 member 用 utf8mb4_unicode_ci（同为 ci）→ 按 LOWER(TRIM(uname)) 归并即覆盖全部真实撞车。
--
-- 结果（2026-10-13 实测）：8 组 / 16 个账号。详见 docs/plans/02-用户名重名处置.md
--
-- 保留者优先序（确定性，越靠前越优先）：
--   ① 有余额（money > 0） ② 有订单 ③ 原值本就无前后空格 ④ 注册更早（regtime 小） ⑤ uid 小
-- 改名者：TRIM(uname) || '_' || uid（带 uid，几乎不可能撞车；T1 回填时仍需做唯一性校验兜底）
--
-- ★ 踩坑记录（务必保留）：
--   ① 判断「尾部空格」不能用 `uname = TRIM(uname)` —— ci 排序下 'a ' = 'a' 为真；
--      必须用 CHAR_LENGTH(uname) = CHAR_LENGTH(TRIM(uname))。
--   ② 前导空格在 ci 下「有效」（不重叠），但新表会 TRIM 掉 → 仍须归并：
--      ' shkomatsuzaki' 与 'shkomatsuzaki' 在旧库是两行，回填后会撞。
--
-- 纪律：本文件只含 SELECT。消歧的「改名」动作属于 T1 回填脚本（写入新表 member），
--       **绝不 UPDATE 旧库 dg_users.uname**。
-- ============================================================================

WITH grp AS (
  SELECT LOWER(TRIM(uname)) AS norm
  FROM dg_users
  WHERE uname IS NOT NULL AND TRIM(uname) <> ''
  GROUP BY LOWER(TRIM(uname))
  HAVING COUNT(*) > 1
),
mem AS (
  SELECT u.uid, u.uname, u.money, u.regtime, LOWER(TRIM(u.uname)) AS norm
  FROM dg_users u
  JOIN grp ON grp.norm = LOWER(TRIM(u.uname))
),
oc AS (
  SELECT o.uid, COUNT(*) AS order_cnt
  FROM dg_order o
  JOIN mem m ON m.uid = o.uid
  GROUP BY o.uid
),
ranked AS (
  SELECT m.uid, m.uname, m.norm,
         COALESCE(oc.order_cnt, 0) AS order_cnt,
         CASE WHEN m.money > 0 THEN 1 ELSE 0 END AS has_money,
         CASE WHEN CHAR_LENGTH(m.uname) = CHAR_LENGTH(TRIM(m.uname)) THEN 1 ELSE 0 END AS is_clean,
         m.regtime
  FROM mem m
  LEFT JOIN oc ON oc.uid = m.uid
),
prim AS (
  SELECT norm,
         SUBSTRING_INDEX(
           GROUP_CONCAT(uid ORDER BY has_money DESC, order_cnt DESC, is_clean DESC, regtime ASC, uid ASC),
           ',', 1
         ) AS keep_uid
  FROM ranked
  GROUP BY norm
)
SELECT
  r.uid,
  CONCAT('[', r.uname, ']')                                    AS uname_raw,
  r.norm,
  r.has_money,
  r.order_cnt,
  r.is_clean,
  FROM_UNIXTIME(r.regtime)                                     AS reg_dt,
  CASE WHEN r.uid = p.keep_uid THEN 'KEEP' ELSE 'RENAME' END   AS action,
  CASE WHEN r.uid = p.keep_uid
       THEN TRIM(r.uname)
       ELSE CONCAT(TRIM(r.uname), '_', r.uid) END              AS proposed_username
FROM ranked r
JOIN prim p ON p.norm = r.norm
ORDER BY r.norm, r.uid;
