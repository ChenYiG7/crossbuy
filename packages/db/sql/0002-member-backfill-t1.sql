-- ============================================================================
-- T1 回填：旧表 → member 域新表（**幂等，可重复执行**）
--
-- 范围（本文件）：member / member_company / member_address 三张核心表
--   （v2_* 侧表 —— webhook / oauth / favorite / browse_history / benefit /
--     operation_log / area / PAT / open_api_idempotency —— 见 §4「第二批」）
--
-- 纪律：
--   ① 只写**新表**，绝不写旧表（dg_users / dg_address 只读）。
--   ② 幂等：`INSERT ... SELECT ... ON DUPLICATE KEY UPDATE`，可反复跑。
--   ③ 显式带 id：`member.id == dg_users.uid`，`member_address.id == dg_address.aid`。
--   ④ 分批：本文件为「一条语句跑全量」，大表建议按 uid 区间切（见文末 §5）。
--   ⑤ 跑完必须执行 §6 顶 AUTO_INCREMENT，否则新写入会撞旧 id。
--
-- ⚠ 执行前先跑 `0003-member-backfill-verify.sql` 的前置断言（用户名唯一性）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 消歧映射（Q4 结果，见 docs/plans/02-用户名重名处置.md）
--    _t1_username_fix   = 需改名的账号（规则：TRIM(原名) + '_' + uid）
--    _t1_username_merge = 被合并的账号 → 主账号（当前仅 Haru0128: 15274 → 15272）
--
--    ★ 2026-10-15（#3g②）：TEMPORARY → **实体暂存表**，理由有二：
--      ① 校验脚本 `0003` 是**独立会话**跑的，看不见临时表，只能把映射再抄一遍字面量 →
--        与正本漂移，且期望值被迫写死生产快照数字（本地演练 4 项无谓 FAIL 的根因）；
--        改为读映射表后，A2~A5 / B6 / B7 的期望值全部**按当前源实时计算**。
--      ② 映射本身就是「哪些账号被改名/合并」的**审计留档**，回填后应可复查。
--    ⚠ 表名以 `_t1_` 前缀标记为回填期暂存物，不属于 Prisma 正本（`0001` 不生成它），
--      与 order 域 `_t1_valid_order` / `_t1_order_group` 同一惯例。DROP + CREATE 保证
--      「脚本里的字面量 = 库里生效的映射」，反复执行幂等。
--    ⚠ `new_username` **故意不写列级 collation**：保持与原临时表一致（继承库默认），
--      这样 §2 那个 `COALESCE(f.new_username, NULLIF(TRIM(u.uname),''), ...)` 的
--      mb3/mb4 混排行为与**已演练通过的版本完全相同**。⇒ 任何脚本要拿它和
--      `member.username`（utf8mb4_general_ci）比较，必须自己
--      `CAST(... AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci`（`0003` A4/B14 已这么做）。
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _t1_username_fix;
CREATE TABLE _t1_username_fix (
  uid          INT PRIMARY KEY,
  new_username VARCHAR(50) NOT NULL
) ENGINE = InnoDB;
INSERT INTO _t1_username_fix (uid, new_username) VALUES
  (4110, 'A1a1_4110'),
  (6685, 'crisis0821_6685'),
  (15274, 'Haru0128_15274'),
  (4018, 'longtai_4018'),
  (1858, 'megutoami_1858'),
  (18105, 'nr7shopping_18105'),
  (3767, 'PEYANG_3767'),
  (4056, 'shkomatsuzaki_4056');

DROP TABLE IF EXISTS _t1_username_merge;
CREATE TABLE _t1_username_merge (
  uid        INT PRIMARY KEY,
  target_uid INT NOT NULL
) ENGINE = InnoDB;
INSERT INTO _t1_username_merge (uid, target_uid) VALUES (15274, 15272);

-- ---------------------------------------------------------------------------
-- 1b. ★ fail-fast 守卫（2026-10-15 本地演练发现的真缺陷，必须先于 §2 执行）
--   症状：§2 用 INSERT..ON DUPLICATE KEY UPDATE，而 member.username 是 UNIQUE。
--         未进映射表的重名对，第二行的 username 撞车后**不会新插一行**，而是走 ODKU
--         把**前一个账号那一行整行覆盖**（`balance = u.money` 取的是后一个账号的钱）。
--         username 撞车恰恰意味着「这是两个不同实体」，ODKU 却按「同一实体重复投递」处理。
--   本地实测（taotaro 副本 7 组重名 vs 映射表只覆盖生产 8 组中的 2 组）：
--         5 个账号被吞（member 5,016 vs 源 5,021）、2 个余额被清零
--         （uid 6932 的 100.18 → 0.00、uid 18213 的 19.96 → 0.00），**全程零报错**。
--   ⇒ 生产风险：Q4 预检（2026-10-13）之后只要有人新注册出重名，T1 就会静默丢账号 + 改余额。
--   规则：**T1 执行前必须重跑 precheck-username-duplicate.sql**，把新出现的重名组补进
--         `_t1_username_fix`，否则本守卫直接中止，绝不让脚本「看起来成功了」。
-- ---------------------------------------------------------------------------
--   ★ 碰撞必须按**目标列 member.username 的 collation**（utf8mb4_general_ci，见 0001a）判定，
--     不能按源列的：源 `dg_users.uname` 是 utf8mb3_general_ci，它会折叠平假名/片假名，
--     而 utf8mb4_general_ci 不折叠（实测 'なおたろう' = 'ナオタロウ'：mb3/unicode 为 1，mb4_general 为 0）。
--     按源 collation 判会**误中止**（本快照两组假名/片假名账号在目标索引下其实不冲突）。
DROP PROCEDURE IF EXISTS _guard_username_disambiguated;
DELIMITER $$
CREATE PROCEDURE _guard_username_disambiguated()
BEGIN
  DECLARE bad INT DEFAULT 0;
  DECLARE sample VARCHAR(512) DEFAULT NULL;
  SELECT COUNT(*),
         SUBSTRING(GROUP_CONCAT(dup.target_username ORDER BY dup.target_username SEPARATOR ', '), 1, 200)
    INTO bad, sample
  FROM (
    SELECT CAST(COALESCE(f.new_username, NULLIF(TRIM(u.uname), ''), CONCAT('user_', u.uid))
                 AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci AS target_username
    FROM dg_users u
    LEFT JOIN _t1_username_fix f ON f.uid = u.uid
    GROUP BY target_username
    HAVING COUNT(*) > 1
  ) dup;
  IF bad > 0 THEN
    SET @guard_msg = CONCAT(
      'T1 ABORT: ', bad,
      ' duplicate target username(s) remain after _t1_username_fix [', COALESCE(sample, '?'),
      ']. Re-run precheck-username-duplicate.sql against the CURRENT source snapshot ',
      'and extend the mapping before backfilling.');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = @guard_msg;
  END IF;
END$$
DELIMITER ;
CALL _guard_username_disambiguated();
DROP PROCEDURE _guard_username_disambiguated;

-- ---------------------------------------------------------------------------
-- 2. member ← dg_users
--    时间：·INT unix 秒 → DATETIME，用 FROM_UNIXTIME(NULLIF(...,0))，
--          空/0 回落 '1970-01-01 00:00:01'（created_at 为 NOT NULL）
--    金额：money DECIMAL(10,2) → balance DECIMAL(12,2)（左对齐）；
--          monpayamt 旧为 **DOUBLE 浮点** → ROUND(...,2) 后再落 DECIMAL
--    密码：password CHAR(32) MD5 → password_hash + password_algo='md5'
--    JSON：cc_emails 旧已是 JSON 类型，直接搬
-- ---------------------------------------------------------------------------
INSERT INTO member (
  id, username, username_original, username_auto_renamed, merged_into_id,
  password_hash, password_algo, email, name, en_name, member_id, face,
  sex, tel, zip, country, city, address, qq, msn, line, wechat, card,
  utype, use_type, state, validity, reg_type, biz_code, belong_company, tag,
  balance, balance_currency, scores, float_rate, last_balance_changed_at,
  order_enable, stop_time,
  df_flag, df_fee, df_send_name, df_send_address, df_send_tel, csv_up_flag,
  realtime_account, shop_name, shop_url, pre_buy_feq, pre_buy_amt, mon_pay_amt,
  origin_package_choice, xz, fb, reg_extra, remark,
  mail_frequency, email_subscribe_status, cc_emails, login_limit_warning,
  stores_free_days, stores_warn_days,
  reg_ip, created_at, login_ip, last_login_at, last_order_at, active_key, updated_at
)
SELECT
  u.uid,
  COALESCE(f.new_username, NULLIF(TRIM(u.uname), ''), CONCAT('user_', u.uid)),
  CASE WHEN f.uid IS NOT NULL THEN TRIM(u.uname) END,
  CASE WHEN f.uid IS NOT NULL THEN 1 ELSE 0 END,
  g.target_uid,
  u.password,
  'md5',
  u.email,
  u.tname,
  u.enname,
  u.memberid,
  u.face,
  u.sex,
  u.tel,
  u.zip,
  u.country,
  u.city,
  u.address,
  u.qq,
  u.msn,
  u.line,
  u.wechat,
  u.card,
  u.utype,
  u.usetype,
  u.state,
  u.validity,
  u.regtype,
  COALESCE(NULLIF(u.biz_code, ''), 'PROXY_PURCHASE'),
  u.belong_company,
  u.tag,
  u.money,
  'CNY',
  u.scores,
  u.floatrate,
  u.last_balance_changed_at,
  u.orderenable,
  FROM_UNIXTIME(NULLIF(u.stoptime, 0)),
  u.dfflag,
  u.dffee,
  u.dfsendname,
  u.dfsendaddress,
  u.dfsendtel,
  u.csvupflag,
  u.realtimeaccount,
  u.shopname,
  u.shopurl,
  u.prebuyfeq,
  u.prebuyamt,
  CASE WHEN u.monpayamt IS NULL THEN NULL ELSE ROUND(u.monpayamt, 2) END,
  u.origin_package_choice,
  u.xz,
  u.fb,
  u.reg_extra,
  u.remark,
  u.mail_frequency,
  u.email_subscribe_status,
  u.cc_emails,
  u.login_limit_warning,
  u.stores_free_days,
  u.stores_warn_days,
  u.regip,
  COALESCE(FROM_UNIXTIME(NULLIF(u.regtime, 0)), '1970-01-01 00:00:01'),
  u.loginip,
  FROM_UNIXTIME(NULLIF(u.logintime, 0)),
  FROM_UNIXTIME(NULLIF(u.lastordertime, 0)),
  u.activekey,
  NOW()
FROM dg_users u
LEFT JOIN _t1_username_fix   f ON f.uid = u.uid
LEFT JOIN _t1_username_merge g ON g.uid = u.uid
ON DUPLICATE KEY UPDATE
  username                = COALESCE(f.new_username, NULLIF(TRIM(u.uname), ''), CONCAT('user_', u.uid)),
  username_original       = CASE WHEN f.uid IS NOT NULL THEN TRIM(u.uname) END,
  username_auto_renamed   = CASE WHEN f.uid IS NOT NULL THEN 1 ELSE 0 END,
  merged_into_id          = g.target_uid,
  password_hash           = u.password,
  password_algo           = 'md5',
  email                   = u.email,
  name                    = u.tname,
  en_name                 = u.enname,
  member_id               = u.memberid,
  face                    = u.face,
  sex                     = u.sex,
  tel                     = u.tel,
  zip                     = u.zip,
  country                 = u.country,
  city                    = u.city,
  address                 = u.address,
  qq                      = u.qq,
  msn                     = u.msn,
  line                    = u.line,
  wechat                  = u.wechat,
  card                    = u.card,
  utype                   = u.utype,
  use_type                = u.usetype,
  state                   = u.state,
  validity                = u.validity,
  reg_type                = u.regtype,
  biz_code                = COALESCE(NULLIF(u.biz_code, ''), 'PROXY_PURCHASE'),
  belong_company          = u.belong_company,
  tag                     = u.tag,
  balance                 = u.money,
  balance_currency        = 'CNY',
  scores                  = u.scores,
  float_rate              = u.floatrate,
  last_balance_changed_at = u.last_balance_changed_at,
  order_enable            = u.orderenable,
  stop_time               = FROM_UNIXTIME(NULLIF(u.stoptime, 0)),
  df_flag                 = u.dfflag,
  df_fee                  = u.dffee,
  df_send_name            = u.dfsendname,
  df_send_address         = u.dfsendaddress,
  df_send_tel             = u.dfsendtel,
  csv_up_flag             = u.csvupflag,
  realtime_account        = u.realtimeaccount,
  shop_name               = u.shopname,
  shop_url                = u.shopurl,
  pre_buy_feq             = u.prebuyfeq,
  pre_buy_amt             = u.prebuyamt,
  mon_pay_amt             = CASE WHEN u.monpayamt IS NULL THEN NULL ELSE ROUND(u.monpayamt, 2) END,
  origin_package_choice   = u.origin_package_choice,
  xz                      = u.xz,
  fb                      = u.fb,
  reg_extra               = u.reg_extra,
  remark                  = u.remark,
  mail_frequency          = u.mail_frequency,
  email_subscribe_status  = u.email_subscribe_status,
  cc_emails               = u.cc_emails,
  login_limit_warning     = u.login_limit_warning,
  stores_free_days        = u.stores_free_days,
  stores_warn_days        = u.stores_warn_days,
  reg_ip                  = u.regip,
  created_at              = COALESCE(FROM_UNIXTIME(NULLIF(u.regtime, 0)), '1970-01-01 00:00:01'),
  login_ip                = u.loginip,
  last_login_at           = FROM_UNIXTIME(NULLIF(u.logintime, 0)),
  last_order_at           = FROM_UNIXTIME(NULLIF(u.lastordertime, 0)),
  active_key              = u.activekey,
  updated_at              = NOW();

-- ---------------------------------------------------------------------------
-- 3. member_company ← dg_users（com* 组，1:1）
--    ⚠ 修正：不再假定「仅 regType=1」——实测 regtype=1 有 2,246 人，但 comname
--       非空者有 7,409 人，二者不一致。改为「regType=1 或任一 com* 字段非空」。
--    member_id 是主键（= uid），天然幂等。
-- ---------------------------------------------------------------------------
INSERT INTO member_company (
  member_id, name, eng_name, manager, manager_eng, post, tel, address, eng_address, zip, bus_num
)
SELECT
  u.uid,
  u.comname,
  u.comengname,
  u.commanager,
  u.commanagereng,
  u.compost,
  u.comptel,
  u.comaddress,
  u.comaddresseng,
  u.comzip,
  u.combusnum
FROM dg_users u
WHERE u.regtype = 1
   OR COALESCE(u.comname,'')        <> '' OR COALESCE(u.comengname,'')    <> ''
   OR COALESCE(u.commanager,'')     <> '' OR COALESCE(u.commanagereng,'') <> ''
   OR COALESCE(u.compost,'')        <> '' OR COALESCE(u.comptel,'')       <> ''
   OR COALESCE(u.comaddress,'')     <> '' OR COALESCE(u.comaddresseng,'') <> ''
   OR COALESCE(u.comzip,'')         <> '' OR COALESCE(u.combusnum,'')     <> ''
ON DUPLICATE KEY UPDATE
  name        = u.comname,
  eng_name    = u.comengname,
  manager     = u.commanager,
  manager_eng = u.commanagereng,
  post        = u.compost,
  tel         = u.comptel,
  address     = u.comaddress,
  eng_address = u.comaddresseng,
  zip         = u.comzip,
  bus_num     = u.combusnum;

-- ---------------------------------------------------------------------------
-- 4. member_address ← dg_address（1:1，id = aid）
--    ★ 2026-10-15（#3g③）：加 `JOIN member` 过滤**外键孤儿**。
--      旧库允许 `dg_address.uid` 指向已删除会员（本地实测 B12 悬空 2 行），
--      回填若不滤，`member_address.member_id` 会指向不存在的行——Prisma 侧
--      `include: { member: true }`（必需关系）在跨域 JOIN 时直接报错。
--      与 0004 侧表回填的孤儿过滤口径一致（favorite 240 / browse 3389 等同源问题）。
--      ⇒ 代价：这些地址行随源一起不进新表；T3 旧表降级前如需找回，按 aid 补录即可。
-- ---------------------------------------------------------------------------
INSERT INTO member_address (
  id, member_id, consignee, en_name, country, city, zip, tel, address, type,
  email, bank_info, corporate_info, is_default, customs_code,
  real_time_account, corporate_number, company_name
)
SELECT
  a.aid, a.uid, a.consignee, a.enname, a.country, a.city, a.zip, a.tel, a.address, a.type,
  a.email, a.bank_info, a.corporate_info, a.def, a.customs_code,
  a.real_time_account, a.corporate_number, a.company_name
FROM dg_address a
JOIN member m ON m.id = a.uid
ON DUPLICATE KEY UPDATE
  member_id        = a.uid,
  consignee        = a.consignee,
  en_name          = a.enname,
  country          = a.country,
  city             = a.city,
  zip              = a.zip,
  tel              = a.tel,
  address          = a.address,
  type             = a.type,
  email            = a.email,
  bank_info        = a.bank_info,
  corporate_info   = a.corporate_info,
  is_default       = a.def,
  customs_code     = a.customs_code,
  real_time_account= a.real_time_account,
  corporate_number = a.corporate_number,
  company_name     = a.company_name;

-- ---------------------------------------------------------------------------
-- 5.【第二批】v2_* / user_* 侧表回填 → 见独立脚本 `0004-member-backfill-t1-part2.sql`
--    （13 张表；字段已按线上 information_schema 核准；含孤儿过滤与 PAT 类型过滤）
--    校验 → `0005-member-backfill-verify-part2.sql`
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. 顶 AUTO_INCREMENT（必须！否则新写入的 id 会从 1 开始撞旧 id）
--    ⚠ MySQL 不允许 ALTER TABLE 里带子查询 → 用预处理语句
-- ---------------------------------------------------------------------------
SET @next_member := (SELECT COALESCE(MAX(uid), 0) + 1 FROM dg_users);
SET @s := CONCAT('ALTER TABLE member AUTO_INCREMENT = ', @next_member);
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @next_addr := (SELECT COALESCE(MAX(aid), 0) + 1 FROM dg_address);
SET @s := CONCAT('ALTER TABLE member_address AUTO_INCREMENT = ', @next_addr);
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 7. 分批建议（大表）
--    将 §2 / §4 的 SELECT 加 `WHERE u.uid BETWEEN ? AND ?`（每批 5000），
--    用外部脚本循环调用；每批各自幂等，可断点续跑。
--    ⚠ §4 现在 `JOIN member`，故它看到的是「§2 已回填到哪」——分批时请按
--      uid 升序推进，且**全部批次跑完后再复跑一次 §4**（幂等），否则地址会漏。
--      漏掉的行由 `0003` 的 B13（INFO：被过滤的孤儿地址数）暴露。
-- ---------------------------------------------------------------------------
