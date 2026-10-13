-- ============================================================================
-- T1 回填（第二批）：v2_* / user_* 侧表 → member 域新表（**幂等，可重复执行**）
--
-- 承接 `0002-member-backfill-t1.sql`（第一批：member / member_company / member_address）。
-- 前置：必须先跑完 0001（建表）+ 0001a（username collation）+ 0002（核心表回填）。
--
-- 覆盖 13 张目标表（源表 → 目标表）：
--   user_benefit_configs        → benefit_config            [2 行]
--   user_benefits               → member_benefit            [718 → 715]
--   user_operation_log          → member_operation_log      [3086 → 3018]
--   v2_member_webhook           → member_webhook            [0 行]
--   v2_member_webhook_delivery  → member_webhook_delivery   [0 行]
--   v2_personal_access_tokens   → personal_access_token     [106368 → 105808]
--   v2_oauth_login              → oauth_login               [1 → 0，孤儿]
--   v2_oauth_taobao_global      → oauth_taobao_global       [1 行]
--   v2_open_api_idempotency     → open_api_idempotency      [0 行]
--   v2_favorite                 → favorite                  [183753 → 183513]
--   v2_favorite_category        → favorite_category         [20 行]
--   v2_user_browse_history      → browse_history            [210051 → 206662]
--   v2_area                     → area                      [1940 行]
--
-- 字段来源：线上 information_schema 实测（122 列 / 13 表），非猜。
--   → 目标列与源列**逐列同名**，唯 `uid` → `member_id`（类型相同）。
--
-- 纪律：
--   ① 只写**新表**，绝不写旧表（v2_* / user_* 只读）。
--   ② 幂等：`INSERT ... SELECT ... ON DUPLICATE KEY UPDATE`，保留源 id。
--   ③ **过滤外键孤儿**：带 `member` 必需关系的表一律 `JOIN member m ON m.id=<uid>`，
--      只回填父行存在的记录（否则 Prisma `include` 会因关系缺失报错）。
--      实测孤儿数：favorite 240 / browse_history 3389 / member_benefit 3 /
--      member_operation_log 68 / oauth_login 1（整表唯一行即孤儿）。
--   ④ 保留源 id（显式带 id）→ 跨系统对账/运维可对齐；跑完必须顶 AUTO_INCREMENT（§末）。
--   ⑤ 大表（favorite / browse_history / personal_access_token）建议分批，见文末注释。
--
-- ⚠ PAT 取舍（需 T2 复决）：仅回填 `App\Models\User` 且父会员存在的 **105,808** 条；
--    排除 539 条 `App\Models\AdminUser`（非会员域）+ 21 条父会员已不存在的 User token。
--    Sanctum token 为 sha256 单向哈希（明文不可恢复），保留 = 老客户端继续可用；
--    若 T2 决定改鉴权方案，可整表清空重发（此决策不影响 T1 数据搬运）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. benefit_config ← user_benefit_configs（须先于 member_benefit）
--    列名逐列同名；JSON 列（benefit_config / user_conditions / features）直接搬。
-- ---------------------------------------------------------------------------
INSERT INTO benefit_config (
  id, benefit_code, benefit_name, benefit_type, benefit_config, valid_days,
  activity_start_at, activity_end_at, user_conditions, status, sort_order,
  features, remark, created_at, updated_at
)
SELECT
  c.id, c.benefit_code, c.benefit_name, c.benefit_type, c.benefit_config, c.valid_days,
  c.activity_start_at, c.activity_end_at, c.user_conditions, c.status, c.sort_order,
  c.features, c.remark, c.created_at, c.updated_at
FROM user_benefit_configs c
ON DUPLICATE KEY UPDATE
  benefit_code     = c.benefit_code,
  benefit_name     = c.benefit_name,
  benefit_type     = c.benefit_type,
  benefit_config   = c.benefit_config,
  valid_days       = c.valid_days,
  activity_start_at= c.activity_start_at,
  activity_end_at  = c.activity_end_at,
  user_conditions  = c.user_conditions,
  status           = c.status,
  sort_order       = c.sort_order,
  features         = c.features,
  remark           = c.remark,
  updated_at       = c.updated_at;

-- ---------------------------------------------------------------------------
-- 2. member_benefit ← user_benefits
--    uid → member_id；JOIN member 过滤 3 条孤儿；benefit_config_id 已由 §1 建好。
-- ---------------------------------------------------------------------------
INSERT INTO member_benefit (
  id, member_id, benefit_config_id, benefit_code, benefit_name, benefit_type,
  benefit_value, status, source, source_id, received_at, start_at, used_at,
  expired_at, features, remark, created_at, updated_at
)
SELECT
  b.id, b.uid, b.benefit_config_id, b.benefit_code, b.benefit_name, b.benefit_type,
  b.benefit_value, b.status, b.source, b.source_id, b.received_at, b.start_at, b.used_at,
  b.expired_at, b.features, b.remark, b.created_at, b.updated_at
FROM user_benefits b
JOIN member m ON m.id = b.uid
ON DUPLICATE KEY UPDATE
  member_id        = b.uid,
  benefit_config_id= b.benefit_config_id,
  benefit_code     = b.benefit_code,
  benefit_name     = b.benefit_name,
  benefit_type     = b.benefit_type,
  benefit_value    = b.benefit_value,
  status           = b.status,
  source           = b.source,
  source_id        = b.source_id,
  received_at      = b.received_at,
  start_at         = b.start_at,
  used_at          = b.used_at,
  expired_at       = b.expired_at,
  features         = b.features,
  remark           = b.remark,
  updated_at       = b.updated_at;

-- ---------------------------------------------------------------------------
-- 3. member_operation_log ← user_operation_log
--    uid → member_id；operator 为后台管理员 uid（0=系统），原样保留。
-- ---------------------------------------------------------------------------
INSERT INTO member_operation_log (id, member_id, operator, remark, created_at, updated_at)
SELECT l.id, l.uid, l.operator, l.remark, l.created_at, l.updated_at
FROM user_operation_log l
JOIN member m ON m.id = l.uid
ON DUPLICATE KEY UPDATE
  member_id  = l.uid,
  operator   = l.operator,
  remark     = l.remark,
  updated_at = l.updated_at;

-- ---------------------------------------------------------------------------
-- 4. member_webhook ← v2_member_webhook（当前 0 行；保留语句以备重跑）
--    uid → member_id（目标 uid 唯一）；enabled tinyint(1) → Boolean。
-- ---------------------------------------------------------------------------
INSERT INTO member_webhook (
  id, member_id, url, secret, enabled, balance_low_threshold, created_at, updated_at
)
SELECT w.id, w.uid, w.url, w.secret, w.enabled, w.balance_low_threshold, w.created_at, w.updated_at
FROM v2_member_webhook w
JOIN member m ON m.id = w.uid
ON DUPLICATE KEY UPDATE
  member_id            = w.uid,
  url                  = w.url,
  secret               = w.secret,
  enabled              = w.enabled,
  balance_low_threshold= w.balance_low_threshold,
  updated_at           = w.updated_at;

-- ---------------------------------------------------------------------------
-- 5. member_webhook_delivery ← v2_member_webhook_delivery（当前 0 行）
--    event_key 唯一（目标 uid + event_key 唯一）。
-- ---------------------------------------------------------------------------
INSERT INTO member_webhook_delivery (
  id, member_id, event, event_key, payload, status, attempts, last_status_code,
  last_error, next_attempt_at, delivered_at, created_at, updated_at
)
SELECT
  d.id, d.uid, d.event, d.event_key, d.payload, d.status, d.attempts, d.last_status_code,
  d.last_error, d.next_attempt_at, d.delivered_at, d.created_at, d.updated_at
FROM v2_member_webhook_delivery d
JOIN member m ON m.id = d.uid
ON DUPLICATE KEY UPDATE
  member_id       = d.uid,
  event           = d.event,
  payload         = d.payload,
  status          = d.status,
  attempts        = d.attempts,
  last_status_code= d.last_status_code,
  last_error      = d.last_error,
  next_attempt_at = d.next_attempt_at,
  delivered_at    = d.delivered_at,
  updated_at      = d.updated_at;

-- ---------------------------------------------------------------------------
-- 6. personal_access_token ← v2_personal_access_tokens（见文件头 PAT 取舍）
--    仅 `App\Models\User` 且父会员存在。token 为 sha256 哈希，原样搬。
--    ⚠ `App\\Models\\User` 在 MySQL 字符串里用双反斜杠转义（\\ → \）。
-- ---------------------------------------------------------------------------
INSERT INTO personal_access_token (
  id, tokenable_type, tokenable_id, name, token, abilities,
  last_used_at, expires_at, created_at, updated_at
)
SELECT
  p.id, p.tokenable_type, p.tokenable_id, p.name, p.token, p.abilities,
  p.last_used_at, p.expires_at, p.created_at, p.updated_at
FROM v2_personal_access_tokens p
JOIN member m ON m.id = p.tokenable_id
WHERE p.tokenable_type = 'App\\Models\\User'
ON DUPLICATE KEY UPDATE
  tokenable_type = p.tokenable_type,
  tokenable_id   = p.tokenable_id,
  name           = p.name,
  token          = p.token,
  abilities      = p.abilities,
  last_used_at   = p.last_used_at,
  expires_at     = p.expires_at,
  updated_at     = p.updated_at;

-- ---------------------------------------------------------------------------
-- 7. oauth_login ← v2_oauth_login（当前唯一行 uid=21095 是孤儿 → JOIN 后 0 行）
--    uk(openid, appid) 目标同名唯一。
-- ---------------------------------------------------------------------------
INSERT INTO oauth_login (id, member_id, appid, openid, detail, created_at, updated_at, deleted_at)
SELECT o.id, o.uid, o.appid, o.openid, o.detail, o.created_at, o.updated_at, o.deleted_at
FROM v2_oauth_login o
JOIN member m ON m.id = o.uid
ON DUPLICATE KEY UPDATE
  member_id  = o.uid,
  appid      = o.appid,
  openid     = o.openid,
  detail     = o.detail,
  updated_at = o.updated_at,
  deleted_at = o.deleted_at;

-- ---------------------------------------------------------------------------
-- 8. oauth_taobao_global ← v2_oauth_taobao_global（uid 可空，无必需关系 → 不加 JOIN）
-- ---------------------------------------------------------------------------
INSERT INTO oauth_taobao_global (id, account, token, member_id, seller_id, created_at, updated_at, deleted_at)
SELECT t.id, t.account, t.token, t.uid, t.seller_id, t.created_at, t.updated_at, t.deleted_at
FROM v2_oauth_taobao_global t
ON DUPLICATE KEY UPDATE
  account    = t.account,
  token      = t.token,
  member_id  = t.uid,
  seller_id  = t.seller_id,
  updated_at = t.updated_at,
  deleted_at = t.deleted_at;

-- ---------------------------------------------------------------------------
-- 9. open_api_idempotency ← v2_open_api_idempotency（当前 0 行）
-- ---------------------------------------------------------------------------
INSERT INTO open_api_idempotency (
  id, member_id, scope, client_key, request_hash, status, response, created_at, updated_at
)
SELECT i.id, i.uid, i.scope, i.client_key, i.request_hash, i.status, i.response, i.created_at, i.updated_at
FROM v2_open_api_idempotency i
JOIN member m ON m.id = i.uid
ON DUPLICATE KEY UPDATE
  member_id   = i.uid,
  scope       = i.scope,
  client_key  = i.client_key,
  request_hash= i.request_hash,
  status      = i.status,
  response    = i.response,
  updated_at  = i.updated_at;

-- ---------------------------------------------------------------------------
-- 10. favorite ← v2_favorite
--     全为 App\Models\Product（无店铺收藏）；extra 为 JSON 文本，原样搬。
--     源无唯一键（同一商品可重复收藏 12 组）→ 保留全部，只靠 PK 幂等。
-- ---------------------------------------------------------------------------
INSERT INTO favorite (
  id, member_id, category_id, favoriteable_type, favoriteable_id, extra, memo, created_at, updated_at
)
SELECT
  f.id, f.uid, f.category_id, f.favoriteable_type, f.favoriteable_id, f.extra, f.memo, f.created_at, f.updated_at
FROM v2_favorite f
JOIN member m ON m.id = f.uid
ON DUPLICATE KEY UPDATE
  member_id       = f.uid,
  category_id     = f.category_id,
  favoriteable_type = f.favoriteable_type,
  favoriteable_id = f.favoriteable_id,
  extra           = f.extra,
  memo            = f.memo,
  updated_at      = f.updated_at;

-- ---------------------------------------------------------------------------
-- 11. favorite_category ← v2_favorite_category
-- ---------------------------------------------------------------------------
INSERT INTO favorite_category (id, member_id, name, type, sort, created_at, updated_at)
SELECT c.id, c.uid, c.name, c.type, c.sort, c.created_at, c.updated_at
FROM v2_favorite_category c
JOIN member m ON m.id = c.uid
ON DUPLICATE KEY UPDATE
  member_id  = c.uid,
  name       = c.name,
  type       = c.type,
  sort       = c.sort,
  updated_at = c.updated_at;

-- ---------------------------------------------------------------------------
-- 12. browse_history ← v2_user_browse_history（高频写；id 有空洞，保留源 id）
-- ---------------------------------------------------------------------------
INSERT INTO browse_history (id, member_id, goods_id, created_at, updated_at)
SELECT h.id, h.uid, h.goods_id, h.created_at, h.updated_at
FROM v2_user_browse_history h
JOIN member m ON m.id = h.uid
ON DUPLICATE KEY UPDATE
  member_id  = h.uid,
  goods_id   = h.goods_id,
  updated_at = h.updated_at;

-- ---------------------------------------------------------------------------
-- 13. area ← v2_area（行政区划字典；无关系、无孤儿）
-- ---------------------------------------------------------------------------
INSERT INTO area (id, name, level, parent_id, country_code, official_code)
SELECT a.id, a.name, a.level, a.parent_id, a.country_code, a.official_code
FROM v2_area a
ON DUPLICATE KEY UPDATE
  name          = a.name,
  level         = a.level,
  parent_id     = a.parent_id,
  country_code  = a.country_code,
  official_code = a.official_code;

-- ---------------------------------------------------------------------------
-- 14. 顶 AUTO_INCREMENT（13 张表；用源表 MAX(id)+1；MySQL 不允许 ALTER 带子查询 → PREPARE）
-- ---------------------------------------------------------------------------
SET @s := CONCAT('ALTER TABLE benefit_config           AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM user_benefit_configs));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE member_benefit          AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM user_benefits));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE member_operation_log    AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM user_operation_log));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE member_webhook          AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_member_webhook));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE member_webhook_delivery AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_member_webhook_delivery));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE personal_access_token   AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_personal_access_tokens));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE oauth_login             AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_oauth_login));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE oauth_taobao_global     AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_oauth_taobao_global));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE open_api_idempotency    AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_open_api_idempotency));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE favorite                AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_favorite));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE favorite_category       AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_favorite_category));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE browse_history          AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_user_browse_history));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
SET @s := CONCAT('ALTER TABLE area                    AUTO_INCREMENT = ', (SELECT COALESCE(MAX(id),0)+1 FROM v2_area));
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 15. 分批建议（大表）
--     对 §6 / §10 / §12 的 SELECT 加 `WHERE <src>.id BETWEEN ? AND ?`（每批 5 万），
--     外层脚本循环调用；每批各自幂等，可断点续跑。favorite 183K / browse 210K /
--     PAT 106K，单条语句一次性跑亦可（MySQL 可承受），但大批量建议分批以免长事务。
-- ---------------------------------------------------------------------------
