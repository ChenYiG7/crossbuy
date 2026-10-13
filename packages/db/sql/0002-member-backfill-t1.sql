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
--    fix   = 需改名的 8 个账号（TRIM 原名 + '_' + uid）
--    merge = 被合并的账号 → 主账号（当前仅 Haru0128: 15274 → 15272）
-- ---------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS _fix;
CREATE TEMPORARY TABLE _fix (uid INT PRIMARY KEY, new_username VARCHAR(50) NOT NULL);
INSERT INTO _fix (uid, new_username) VALUES
  (4110, 'A1a1_4110'),
  (6685, 'crisis0821_6685'),
  (15274, 'Haru0128_15274'),
  (4018, 'longtai_4018'),
  (1858, 'megutoami_1858'),
  (18105, 'nr7shopping_18105'),
  (3767, 'PEYANG_3767'),
  (4056, 'shkomatsuzaki_4056');

DROP TEMPORARY TABLE IF EXISTS _merge;
CREATE TEMPORARY TABLE _merge (uid INT PRIMARY KEY, target_uid INT NOT NULL);
INSERT INTO _merge (uid, target_uid) VALUES (15274, 15272);

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
  m.target_uid,
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
  'JPY',
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
LEFT JOIN _fix   f ON f.uid = u.uid
LEFT JOIN _merge m ON m.uid = u.uid
ON DUPLICATE KEY UPDATE
  username                = COALESCE(f.new_username, NULLIF(TRIM(u.uname), ''), CONCAT('user_', u.uid)),
  username_original       = CASE WHEN f.uid IS NOT NULL THEN TRIM(u.uname) END,
  username_auto_renamed   = CASE WHEN f.uid IS NOT NULL THEN 1 ELSE 0 END,
  merged_into_id          = m.target_uid,
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
  balance_currency        = 'JPY',
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
-- 5. 【第二批】v2_* 侧表回填（本轮未做，需先核各自源表字段）
--    v2_member_webhook → member_webhook
--    v2_member_webhook_delivery → member_webhook_delivery
--    v2_personal_access_tokens → personal_access_token
--    v2_oauth_login → oauth_login
--    v2_oauth_taobao_global → oauth_taobao_global
--    v2_open_api_idempotency → open_api_idempotency
--    v2_favorite / v2_favorite_category → favorite / favorite_category
--    v2_user_browse_history → browse_history
--    user_benefit_configs / user_benefits → benefit_config / member_benefit
--    user_operation_log → member_operation_log
--    v2_area → area
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
-- ---------------------------------------------------------------------------
