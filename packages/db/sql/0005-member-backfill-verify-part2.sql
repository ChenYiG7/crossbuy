-- ============================================================================
-- T1 回填（第二批）一致性校验（**只读断言**，跑完 `0004` 后必跑）
-- 用法：对每个 SELECT 看 result 列是否全 PASS。
-- 设计：expected 由**源表 JOIN member** 实时算出（不写死数字）→ 本地 dry-run 与生产同样适用。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 组 A：行数 + 外键完整性（每张表一行：expected 由源表推导，actual 取新表）
-- ---------------------------------------------------------------------------
SELECT 'A01 benefit_config 行数' AS check_name,
  (SELECT COUNT(*) FROM user_benefit_configs) AS expected,
  (SELECT COUNT(*) FROM benefit_config) AS actual,
  IF((SELECT COUNT(*) FROM benefit_config) = (SELECT COUNT(*) FROM user_benefit_configs),'PASS','FAIL') AS result
UNION ALL
SELECT 'A02 member_benefit 行数(父会员存在)',
  (SELECT COUNT(*) FROM user_benefits b JOIN member m ON m.id=b.uid),
  (SELECT COUNT(*) FROM member_benefit),
  IF((SELECT COUNT(*) FROM member_benefit) = (SELECT COUNT(*) FROM user_benefits b JOIN member m ON m.id=b.uid),'PASS','FAIL')
UNION ALL
SELECT 'A03 member_operation_log 行数',
  (SELECT COUNT(*) FROM user_operation_log l JOIN member m ON m.id=l.uid),
  (SELECT COUNT(*) FROM member_operation_log),
  IF((SELECT COUNT(*) FROM member_operation_log) = (SELECT COUNT(*) FROM user_operation_log l JOIN member m ON m.id=l.uid),'PASS','FAIL')
UNION ALL
SELECT 'A04 member_webhook 行数',
  (SELECT COUNT(*) FROM v2_member_webhook w JOIN member m ON m.id=w.uid),
  (SELECT COUNT(*) FROM member_webhook),
  IF((SELECT COUNT(*) FROM member_webhook) = (SELECT COUNT(*) FROM v2_member_webhook w JOIN member m ON m.id=w.uid),'PASS','FAIL')
UNION ALL
SELECT 'A05 member_webhook_delivery 行数',
  (SELECT COUNT(*) FROM v2_member_webhook_delivery d JOIN member m ON m.id=d.uid),
  (SELECT COUNT(*) FROM member_webhook_delivery),
  IF((SELECT COUNT(*) FROM member_webhook_delivery) = (SELECT COUNT(*) FROM v2_member_webhook_delivery d JOIN member m ON m.id=d.uid),'PASS','FAIL')
UNION ALL
SELECT 'A06 personal_access_token 行数(User型且父会员存在)',
  (SELECT COUNT(*) FROM v2_personal_access_tokens p JOIN member m ON m.id=p.tokenable_id WHERE p.tokenable_type='App\\Models\\User'),
  (SELECT COUNT(*) FROM personal_access_token),
  IF((SELECT COUNT(*) FROM personal_access_token) = (SELECT COUNT(*) FROM v2_personal_access_tokens p JOIN member m ON m.id=p.tokenable_id WHERE p.tokenable_type='App\\Models\\User'),'PASS','FAIL')
UNION ALL
SELECT 'A07 oauth_login 行数(父会员存在)',
  (SELECT COUNT(*) FROM v2_oauth_login o JOIN member m ON m.id=o.uid),
  (SELECT COUNT(*) FROM oauth_login),
  IF((SELECT COUNT(*) FROM oauth_login) = (SELECT COUNT(*) FROM v2_oauth_login o JOIN member m ON m.id=o.uid),'PASS','FAIL')
UNION ALL
SELECT 'A08 oauth_taobao_global 行数',
  (SELECT COUNT(*) FROM v2_oauth_taobao_global),
  (SELECT COUNT(*) FROM oauth_taobao_global),
  IF((SELECT COUNT(*) FROM oauth_taobao_global) = (SELECT COUNT(*) FROM v2_oauth_taobao_global),'PASS','FAIL')
UNION ALL
SELECT 'A09 open_api_idempotency 行数',
  (SELECT COUNT(*) FROM v2_open_api_idempotency i JOIN member m ON m.id=i.uid),
  (SELECT COUNT(*) FROM open_api_idempotency),
  IF((SELECT COUNT(*) FROM open_api_idempotency) = (SELECT COUNT(*) FROM v2_open_api_idempotency i JOIN member m ON m.id=i.uid),'PASS','FAIL')
UNION ALL
SELECT 'A10 favorite 行数',
  (SELECT COUNT(*) FROM v2_favorite f JOIN member m ON m.id=f.uid),
  (SELECT COUNT(*) FROM favorite),
  IF((SELECT COUNT(*) FROM favorite) = (SELECT COUNT(*) FROM v2_favorite f JOIN member m ON m.id=f.uid),'PASS','FAIL')
UNION ALL
SELECT 'A11 favorite_category 行数',
  (SELECT COUNT(*) FROM v2_favorite_category c JOIN member m ON m.id=c.uid),
  (SELECT COUNT(*) FROM favorite_category),
  IF((SELECT COUNT(*) FROM favorite_category) = (SELECT COUNT(*) FROM v2_favorite_category c JOIN member m ON m.id=c.uid),'PASS','FAIL')
UNION ALL
SELECT 'A12 browse_history 行数',
  (SELECT COUNT(*) FROM v2_user_browse_history h JOIN member m ON m.id=h.uid),
  (SELECT COUNT(*) FROM browse_history),
  IF((SELECT COUNT(*) FROM browse_history) = (SELECT COUNT(*) FROM v2_user_browse_history h JOIN member m ON m.id=h.uid),'PASS','FAIL')
UNION ALL
SELECT 'A13 area 行数',
  (SELECT COUNT(*) FROM v2_area),
  (SELECT COUNT(*) FROM area),
  IF((SELECT COUNT(*) FROM area) = (SELECT COUNT(*) FROM v2_area),'PASS','FAIL');

-- ---------------------------------------------------------------------------
-- 组 B：外键悬空（全部必须为 0）★ 关键——关系为必需，孤儿会让 Prisma include 报错
-- ---------------------------------------------------------------------------
SELECT 'B01 member_benefit.member_id 悬空' AS check_name, 0 AS expected,
  (SELECT COUNT(*) FROM member_benefit x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL) AS actual,
  IF((SELECT COUNT(*) FROM member_benefit x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL') AS result
UNION ALL
SELECT 'B02 member_benefit.benefit_config_id 悬空', 0,
  (SELECT COUNT(*) FROM member_benefit x LEFT JOIN benefit_config c ON c.id=x.benefit_config_id WHERE c.id IS NULL),
  IF((SELECT COUNT(*) FROM member_benefit x LEFT JOIN benefit_config c ON c.id=x.benefit_config_id WHERE c.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B03 member_operation_log.member_id 悬空', 0,
  (SELECT COUNT(*) FROM member_operation_log x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL),
  IF((SELECT COUNT(*) FROM member_operation_log x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B04 member_webhook.member_id 悬空', 0,
  (SELECT COUNT(*) FROM member_webhook x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL),
  IF((SELECT COUNT(*) FROM member_webhook x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B05 oauth_login.member_id 悬空', 0,
  (SELECT COUNT(*) FROM oauth_login x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL),
  IF((SELECT COUNT(*) FROM oauth_login x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B06 favorite.member_id 悬空', 0,
  (SELECT COUNT(*) FROM favorite x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL),
  IF((SELECT COUNT(*) FROM favorite x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B07 favorite_category.member_id 悬空', 0,
  (SELECT COUNT(*) FROM favorite_category x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL),
  IF((SELECT COUNT(*) FROM favorite_category x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B08 browse_history.member_id 悬空', 0,
  (SELECT COUNT(*) FROM browse_history x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL),
  IF((SELECT COUNT(*) FROM browse_history x LEFT JOIN member m ON m.id=x.member_id WHERE m.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'B09 personal_access_token 含非 User 类型(应为0)', 0,
  (SELECT COUNT(*) FROM personal_access_token WHERE tokenable_type <> 'App\\Models\\User'),
  IF((SELECT COUNT(*) FROM personal_access_token WHERE tokenable_type <> 'App\\Models\\User')=0,'PASS','FAIL');

-- ---------------------------------------------------------------------------
-- 组 C：id 保留 + AUTO_INCREMENT 已顶高
-- ---------------------------------------------------------------------------
SELECT 'C02 favorite 源 id 全部落到新表(缺失数)', 0,
  (SELECT COUNT(*) FROM v2_favorite s JOIN member m ON m.id=s.uid
     LEFT JOIN favorite x ON x.id=s.id WHERE x.id IS NULL),
  IF((SELECT COUNT(*) FROM v2_favorite s JOIN member m ON m.id=s.uid
        LEFT JOIN favorite x ON x.id=s.id WHERE x.id IS NULL)=0,'PASS','FAIL')
UNION ALL
SELECT 'C03 browse_history 源 id 全部落到新表(缺失数)', 0,
  (SELECT COUNT(*) FROM v2_user_browse_history s JOIN member m ON m.id=s.uid
     LEFT JOIN browse_history x ON x.id=s.id WHERE x.id IS NULL),
  IF((SELECT COUNT(*) FROM v2_user_browse_history s JOIN member m ON m.id=s.uid
        LEFT JOIN browse_history x ON x.id=s.id WHERE x.id IS NULL)=0,'PASS','FAIL');

-- AUTO_INCREMENT 汇总（列出**未顶高**的表；全 OK 时显示「全部已顶高」）
SELECT 'C10 AUTO_INCREMENT 未顶高的表' AS check_name,
       IFNULL(GROUP_CONCAT(t.n SEPARATOR ' | '), '全部已顶高') AS detail
FROM (
  SELECT 'benefit_config' n, (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='benefit_config') > (SELECT COALESCE(MAX(id),0) FROM benefit_config) ok
  UNION ALL SELECT 'member_benefit',        (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='member_benefit') > (SELECT COALESCE(MAX(id),0) FROM member_benefit)
  UNION ALL SELECT 'member_operation_log',  (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='member_operation_log') > (SELECT COALESCE(MAX(id),0) FROM member_operation_log)
  UNION ALL SELECT 'personal_access_token', (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='personal_access_token') > (SELECT COALESCE(MAX(id),0) FROM personal_access_token)
  UNION ALL SELECT 'oauth_taobao_global',   (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='oauth_taobao_global') > (SELECT COALESCE(MAX(id),0) FROM oauth_taobao_global)
  UNION ALL SELECT 'favorite',              (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='favorite') > (SELECT COALESCE(MAX(id),0) FROM favorite)
  UNION ALL SELECT 'favorite_category',     (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='favorite_category') > (SELECT COALESCE(MAX(id),0) FROM favorite_category)
  UNION ALL SELECT 'browse_history',        (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='browse_history') > (SELECT COALESCE(MAX(id),0) FROM browse_history)
  UNION ALL SELECT 'area',                  (SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='area') > (SELECT COALESCE(MAX(id),0) FROM area)
) t WHERE t.ok = 0;
-- ↑ detail = 「全部已顶高」即通过；若列出表名，则这些表需重跑 §14。

-- ---------------------------------------------------------------------------
-- 组 D：抽样明细（人工核对）
-- ---------------------------------------------------------------------------
SELECT 'D1 benefit_config' AS section;
SELECT id, benefit_code, benefit_name, benefit_type, valid_days, status FROM benefit_config ORDER BY id;

SELECT 'D2 member_benefit 抽样' AS section;
SELECT b.id, b.member_id, b.benefit_config_id, b.benefit_code, b.status, b.source FROM member_benefit b ORDER BY b.id LIMIT 10;

SELECT 'D3 PAT 抽样' AS section;
SELECT id, tokenable_type, tokenable_id, name, CHAR_LENGTH(token) token_len, expires_at FROM personal_access_token ORDER BY id LIMIT 10;

SELECT 'D4 favorite 抽样' AS section;
SELECT id, member_id, category_id, favoriteable_type, favoriteable_id, memo FROM favorite ORDER BY id LIMIT 10;
