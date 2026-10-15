-- ============================================================================
-- T1 回填（核心）：send_orders / send_order_status_histories
--                + orders.send_order_id 修正（oids 双写废除后的单侧关联校正）
--
-- 上游决策：
--   · send-order 域设计 docs/plans/send-order-schema.md；Q3（发票归本域）等
--     七条未决问题收口见 docs/plans/06-send-order-评审与拍板.md
--   · §4.2：关系只存 orders.send_order_id 一侧；dg_sendorder.oids 仅作校验，
--     禁作回填源、禁反写旧表
--   · §4.3：totalfee 禁信历史值（旧双口径脏数据未回填）→ charged_total_fee
--     一律 NULL，五费分列落库，业务读值服务端现算
--   · Q7：bundledInto 纯组织关系，禁金额 rollup
--
-- 纪律（沿用 order 域 0007）：
--   ① 只写新表，绝不写旧表（dg_sendorder 等只读）。
--   ② 幂等：INSERT ... SELECT ... ON DUPLICATE KEY UPDATE，可反复跑。
--   ③ 显式带 id：send_orders.id == dg_sendorder.sid（sid 有空洞，顶自增 MAX(id)+1）。
--   ④ JOIN member 过滤外键孤儿（本地 dg_sendorder 18,078 行 → 有效 3,437 行）。
--   ⑤ INT unix → DATETIME 一律 FROM_UNIXTIME（禁 PHP date 直转，+08:00 坑）。
--   ⑥ float → Decimal 无损；禁 PHP 侧运算。
--
-- ⚠ 本地演练前置：先跑 0010-send-order-source-import.sql。
--   生产 T1：源表同库，裸表名直接执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 分段序号表（sn 的 '#' 多单号拆分用；仅 1..64，本地多段 sn 最长 10+ 段）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _t1_numbers;
CREATE TABLE _t1_numbers (i INT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO _t1_numbers (i)
WITH RECURSIVE seq AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM seq WHERE i < 64)
SELECT i FROM seq;

-- ---------------------------------------------------------------------------
-- 1. send_orders：sid 对齐回填（单遍；dg_sendorder 只被引用一次，无需暂存基线表）
--
-- 字段转换要点（§五草案 + 06 拍板）：
--   · sn：# 多单号 → 首段入 sn，全量拆分 {trackingNumbers:[...]} 入 snExtra（Q10）
--   · countweight：十进制千克 → ROUND(CAST(*1000)) 克；脏值 NULL + legacyExtra 留档（Q2）
--   · mailremark：双形态拆分——'{' 开头且 JSON_VALID → remark/files 两列（§4.9）
--   · importer_info：'{' 开头且 JSON_VALID → JSON（§4.8，禁掩码逻辑归保存服务）
--   · mark_flag：原样入 markFlags（本地全 NULL 无位定义，Q5 拍板不拆包）
--   · xiwgfei/xwdj：damageFee/damageUnitPrice 可空审计列（本地全 0，Q1）
--   · status_entered_at：旧系统无 per-state 时间戳 → uptime（最接近进入当前态），
--     兜底 addtime；合成历史行同此口径
--   · charged_total_fee：NULL（totalfee 历史双口径脏数据禁回填，§4.3）
--   · uname/memberid/email：会员副本禁冗余（join member），不回填
--   · did：与 deliveryname 不对应已废弃（Q6），不回填
-- ---------------------------------------------------------------------------
INSERT INTO send_orders (
  id, bundled_into_id, sn, sn_extra, member_id, order_type, status, status_entered_at,
  prostate, prostate_entered_at,
  international_freight, purchase_international_freight, service_fee, customs_fee,
  remote_fee, domestic_shipping_fee, insurance_fee, charged_total_fee,
  bargain_amount, bargain_refunded, bargain_refunded_at,
  coupon_id, coupon_amount, damage_fee, damage_unit_price, received_fee,
  storage_fee, chargeable_amount, chargeable_weight_grams,
  consignee, en_name, country, city, zip, tel, address,
  importer_info, company_name, remark,
  delivery_channel, delivery_area, shipping_warehouse, pass_type, can_ship,
  df_receive_code, df_tracking_no, df_consignee, df_tel, df_address, df_info, df_remark_cn,
  invoice_delivered, invoice_delivered_at, invoice_completed_type, invoice_completed_at,
  total_packages, package_name, package_id, made_in_china_flag, origin_package_keep,
  mail_remark, mail_attachments, comment, mark_flags, legacy_extra,
  created_at, updated_at, deleted_at
)
SELECT
  s.sid,
  NULLIF(s.parent_id, 0),
  NULLIF(SUBSTRING_INDEX(s.sn, '#', 1), ''),
  CASE WHEN s.sn LIKE '%#%' THEN (
    SELECT JSON_OBJECT('trackingNumbers',
      JSON_ARRAYAGG(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(s.sn, '#', n.i), '#', -1))))
    FROM _t1_numbers n
    WHERE n.i <= CHAR_LENGTH(s.sn) - CHAR_LENGTH(REPLACE(s.sn, '#', '')) + 1
  ) END,
  s.uid,
  COALESCE(s.otype, 1),
  COALESCE(s.state, 1),
  COALESCE(FROM_UNIXTIME(NULLIF(s.uptime, 0)), FROM_UNIXTIME(NULLIF(s.addtime, 0)), NOW()),
  s.prostate,
  FROM_UNIXTIME(NULLIF(s.prostatetime, 0)),
  COALESCE(s.freight, 0.00),
  COALESCE(s.ufreight, 0.00),
  COALESCE(s.serverfee, 0.00),
  COALESCE(s.customsfee, 0.00),
  COALESCE(s.remotefee, 0.00),
  COALESCE(s.sendprice, 0.00),
  COALESCE(s.Insurancefee, 0.00),
  NULL,
  COALESCE(s.bargainprice, 0.00),
  s.bargainstate = 1,
  NULL,
  NULLIF(s.couponid, 0),
  NULLIF(s.couponmoney, 0),
  NULLIF(s.xiwgfei, 0),
  NULLIF(s.xwdj, ''),
  NULLIF(s.yishouqufee, 0),
  NULLIF(s.storage, 0),
  NULLIF(s.countmoney, 0),
  CASE WHEN s.countweight REGEXP '^[0-9]+(\.[0-9]+)?$'
    THEN ROUND(CAST(s.countweight AS DECIMAL(12, 4)) * 1000) END,
  COALESCE(NULLIF(s.consignee, ''), '(unknown)'),
  NULLIF(s.enname, ''),
  NULLIF(s.country, ''),
  NULLIF(s.city, ''),
  NULLIF(s.zip, ''),
  NULLIF(s.tel, ''),
  NULLIF(s.address, ''),
  CASE WHEN s.importer_info IS NOT NULL AND s.importer_info <> ''
    AND LEFT(s.importer_info, 1) = '{' AND JSON_VALID(s.importer_info)
    THEN CAST(s.importer_info AS JSON) END,
  NULLIF(s.company_name, ''),
  NULLIF(s.remark, ''),
  NULLIF(s.deliveryname, ''),
  NULLIF(s.areaname, ''),
  NULLIF(s.shipping_warehouse, ''),
  NULLIF(s.passtype, 0),
  s.dfsendflag = 1,
  NULLIF(s.dfshcode, ''),
  NULLIF(s.dflwh, ''),
  NULLIF(s.dfsendname, ''),
  NULLIF(s.dfsendtel, ''),
  NULLIF(s.dfsendaddress, ''),
  NULLIF(s.dfsendinfo, ''),
  NULLIF(s.dfremarkcn, ''),
  s.havefapiao = 1,
  FROM_UNIXTIME(NULLIF(s.fapiaotime, 0)),
  COALESCE(s.invoice_completed_type, 1),
  s.invoice_completed_at,
  COALESCE(s.totalpackages, 0),
  NULLIF(s.packagename, ''),
  NULLIF(s.packageid, 0),
  COALESCE(s.madeinchina_flag, 0),
  s.origin_package_choice = 1,
  CASE WHEN s.mailremark IS NOT NULL AND LEFT(s.mailremark, 1) = '{'
    AND JSON_VALID(s.mailremark)
    THEN NULLIF(JSON_UNQUOTE(JSON_EXTRACT(CAST(s.mailremark AS JSON), '$.remark')), '')
    ELSE NULLIF(s.mailremark, '') END,
  CASE WHEN s.mailremark IS NOT NULL AND LEFT(s.mailremark, 1) = '{'
    AND JSON_VALID(s.mailremark)
    THEN JSON_EXTRACT(CAST(s.mailremark AS JSON), '$.files') END,
  CASE WHEN COALESCE(s.comment, '') <> '' OR COALESCE(s.reply, '') <> '' THEN JSON_OBJECT(
    'content', NULLIF(s.comment, ''),
    'reply', NULLIF(s.reply, ''),
    'show', COALESCE(s.showcomment, 0),
    'commentedAt', FROM_UNIXTIME(NULLIF(s.commenttime, 0))
  ) END,
  s.mark_flag,
  CASE WHEN s.countweight IS NOT NULL AND s.countweight <> '' AND s.countweight <> '0'
    AND s.countweight NOT REGEXP '^[0-9]+(\.[0-9]+)?$'
    THEN JSON_OBJECT('countweightRaw', s.countweight) END,
  FROM_UNIXTIME(NULLIF(s.addtime, 0)),
  FROM_UNIXTIME(NULLIF(s.uptime, 0)),
  NULL
FROM dg_sendorder s
JOIN member m ON m.id = s.uid
ON DUPLICATE KEY UPDATE
  bundled_into_id = VALUES(bundled_into_id),
  sn = VALUES(sn),
  sn_extra = VALUES(sn_extra),
  member_id = VALUES(member_id),
  order_type = VALUES(order_type),
  status = VALUES(status),
  status_entered_at = VALUES(status_entered_at),
  prostate = VALUES(prostate),
  prostate_entered_at = VALUES(prostate_entered_at),
  international_freight = VALUES(international_freight),
  purchase_international_freight = VALUES(purchase_international_freight),
  service_fee = VALUES(service_fee),
  customs_fee = VALUES(customs_fee),
  remote_fee = VALUES(remote_fee),
  domestic_shipping_fee = VALUES(domestic_shipping_fee),
  insurance_fee = VALUES(insurance_fee),
  bargain_amount = VALUES(bargain_amount),
  bargain_refunded = VALUES(bargain_refunded),
  coupon_id = VALUES(coupon_id),
  coupon_amount = VALUES(coupon_amount),
  damage_fee = VALUES(damage_fee),
  damage_unit_price = VALUES(damage_unit_price),
  received_fee = VALUES(received_fee),
  storage_fee = VALUES(storage_fee),
  chargeable_amount = VALUES(chargeable_amount),
  chargeable_weight_grams = VALUES(chargeable_weight_grams),
  consignee = VALUES(consignee),
  en_name = VALUES(en_name),
  country = VALUES(country),
  city = VALUES(city),
  zip = VALUES(zip),
  tel = VALUES(tel),
  address = VALUES(address),
  importer_info = VALUES(importer_info),
  company_name = VALUES(company_name),
  remark = VALUES(remark),
  delivery_channel = VALUES(delivery_channel),
  delivery_area = VALUES(delivery_area),
  shipping_warehouse = VALUES(shipping_warehouse),
  pass_type = VALUES(pass_type),
  can_ship = VALUES(can_ship),
  df_receive_code = VALUES(df_receive_code),
  df_tracking_no = VALUES(df_tracking_no),
  df_consignee = VALUES(df_consignee),
  df_tel = VALUES(df_tel),
  df_address = VALUES(df_address),
  df_info = VALUES(df_info),
  df_remark_cn = VALUES(df_remark_cn),
  invoice_delivered = VALUES(invoice_delivered),
  invoice_delivered_at = VALUES(invoice_delivered_at),
  invoice_completed_type = VALUES(invoice_completed_type),
  invoice_completed_at = VALUES(invoice_completed_at),
  total_packages = VALUES(total_packages),
  package_name = VALUES(package_name),
  package_id = VALUES(package_id),
  made_in_china_flag = VALUES(made_in_china_flag),
  origin_package_keep = VALUES(origin_package_keep),
  mail_remark = VALUES(mail_remark),
  mail_attachments = VALUES(mail_attachments),
  comment = VALUES(comment),
  mark_flags = VALUES(mark_flags),
  legacy_extra = VALUES(legacy_extra),
  created_at = VALUES(created_at),
  updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 2. send_order_status_histories：合成初始态一行（kind='state'）
--    旧系统无迁移表白名单；历史逐态迁移无法从平铺时间列可靠还原——
--    per-state 时间戳本就缺失（仅 addtime/uptime），初始行即当前态，审计按 sid 反查旧库
--
--    ⚠ 幂等守卫用 NOT EXISTS 而非 ODKU：本表无唯一键（历史表语义——真实迁移
--       会重复 toStatus，禁建 unique），而 from_status=NULL 在唯一索引里不去重。
--       与 0007 order 域同款修正（2026-10-15）。
-- ---------------------------------------------------------------------------
INSERT INTO send_order_status_histories (
  send_order_id, kind, from_status, to_status, operator_type, operator_id, reason, created_at
)
SELECT so.id, 'state', NULL, so.status, 'system', NULL, 'T1 backfill', so.created_at
FROM send_orders so
WHERE NOT EXISTS (
  SELECT 1 FROM send_order_status_histories h
  WHERE h.send_order_id = so.id AND h.kind = 'state' AND h.reason = 'T1 backfill'
);

-- ---------------------------------------------------------------------------
-- 2.5 bundledInto 悬空收口：子运单有效但父运单被 member 过滤（uid 孤儿）时，
--     禁留悬空引用——bundled_into_id 置 NULL，父 sid 原值留档 legacyExtra
--     （生产全量数据下此类行应极少；本地 4 例）
--     幂等：置 NULL 后不再匹配 WHERE，重跑 0 行变更
--     ⚠ MySQL SET 从左到右求值：legacy_extra 先算（此时 bundled_into_id 还是旧值），
--        最后才置 NULL——顺序反了会把 NULL 写进 legacy_extra
-- ---------------------------------------------------------------------------
UPDATE send_orders c
LEFT JOIN send_orders p ON p.id = c.bundled_into_id
SET c.legacy_extra = CASE
      WHEN c.legacy_extra IS NULL THEN JSON_OBJECT('bundledIntoLegacySid', c.bundled_into_id)
      ELSE JSON_SET(c.legacy_extra, '$.bundledIntoLegacySid', c.bundled_into_id)
    END,
    c.bundled_into_id = NULL
WHERE c.bundled_into_id IS NOT NULL AND p.id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. orders.send_order_id 修正（oid → sid 单侧关联，§4.2）
--    0007 已按 dg_order.sid 裸 CAST 写过一版，但有两处口径要收口：
--      a) sid='0' → 应为 NULL（CAST('0')=0 是脏值）
--      b) sid 指向的运单不在 send_orders（uid 孤儿运单）→ 应为 NULL（禁悬空引用）
--    LEFT JOIN + 空安全比较（<=>）保证幂等：重跑时 0 行变更
-- ---------------------------------------------------------------------------
UPDATE orders o
JOIN dg_order d ON o.id = d.oid
LEFT JOIN send_orders so
  ON so.id = CASE WHEN d.sid REGEXP '^[0-9]+$' AND d.sid <> '0' THEN CAST(d.sid AS SIGNED) END
SET o.send_order_id = so.id
WHERE NOT (o.send_order_id <=> so.id);

-- ---------------------------------------------------------------------------
-- 4. 顶 AUTO_INCREMENT（保留旧 id 的表；用 MAX(id)+1，禁行数——sid 有空洞）
-- ---------------------------------------------------------------------------
SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM send_orders);
SET @sql := CONCAT('ALTER TABLE send_orders AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM send_order_status_histories);
SET @sql := CONCAT('ALTER TABLE send_order_status_histories AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 5. 完事快照
-- ---------------------------------------------------------------------------
SELECT 'send_orders' AS tbl, COUNT(*) AS rows_now FROM send_orders
UNION ALL SELECT 'send_order_status_histories', COUNT(*) FROM send_order_status_histories
UNION ALL SELECT 'orders_with_send_order', COUNT(*) FROM orders WHERE send_order_id IS NOT NULL
UNION ALL SELECT '有效运单基线(JOIN member)', COUNT(*) FROM dg_sendorder s JOIN member m ON m.id = s.uid;

-- 6. 清理暂存表
DROP TABLE IF EXISTS _t1_numbers;
