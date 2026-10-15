-- ============================================================================
-- T1 回填（侧表）：send_order_value_added_services / invoices
--                + labels / invoice_events（本地无源表，PREPARE 条件跳过）
--
-- 上游决策：
--   · Q3 拍板：dg_fapiao 归 send-order 域（06-send-order-评审与拍板.md §一）
--   · §4.6：invoices.id == dg_fapiao.fid；整表是出货文件快照，禁反查实时表
--   · §4.2：oids 双写废除——本脚本禁出现任何对 dg_sendorder.oids 的写入
--
-- 纪律（沿用 0008/0011）：
--   ① 只写新表；② 幂等 ODKU；③ 显式带 id；④ JOIN send_orders 过滤孤儿
--      （invoices 必须 JOIN——本地 fapiao 子集已按 sid 预过滤，生产按 fid 分片时
--        同样要 JOIN send_orders，防 sid 孤儿）；⑤ unix → FROM_UNIXTIME。
--
-- ⚠ 本地演练前置：0010（源表落地）+ 0011（send_orders 就绪）。
--   生产 T1：源表同库裸表名；dg_fapiao 446 万行必须按 fid 分片 + 短连接。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. send_order_value_added_services（旧源 v2_sendorder_value_added_service，本地 36 行）
-- ---------------------------------------------------------------------------
INSERT INTO send_order_value_added_services (
  id, send_order_id, service_id, name_snapshot, fee, is_manual, created_at, updated_at
)
SELECT v.id, v.sid, v.service_id, v.name_snapshot, v.fee, v.is_manual = 1, v.created_at, v.updated_at
FROM v2_sendorder_value_added_service v
JOIN send_orders so ON so.id = v.sid
ON DUPLICATE KEY UPDATE
  service_id = VALUES(service_id),
  name_snapshot = VALUES(name_snapshot),
  fee = VALUES(fee),
  is_manual = VALUES(is_manual),
  created_at = VALUES(created_at),
  updated_at = VALUES(updated_at);

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM send_order_value_added_services);
SET @sql := CONCAT('ALTER TABLE send_order_value_added_services AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 2. send_order_labels（旧源 v2_send_order_label）
--    本地副本无此表 → PREPARE 条件执行：表存在才回填，否则输出 SKIP 提示。
--    生产跑前经跳板机只读确认行数（Q8）。
-- ---------------------------------------------------------------------------
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'v2_send_order_label'
);
SET @sql := IF(@src_exists > 0,
  'INSERT INTO send_order_labels (
     id, send_order_id, member_id, type, file_path, file_name, mime, size,
     fba_shipment_id, destination_code, boxes, status, scan_result, photo_urls,
     applied_at, verified_at, created_at, updated_at, deleted_at
   )
   SELECT l.id, l.sid, l.uid, l.type, l.file_path, l.file_name, l.mime, l.size,
     NULLIF(l.fba_shipment_id, ''''), NULLIF(l.destination_code, ''''),
     l.boxes, l.status, l.scan_result, l.photo_urls,
     l.applied_at, l.verified_at, l.created_at, l.updated_at, l.deleted_at
   FROM v2_send_order_label l
   JOIN send_orders so ON so.id = l.sid
   ON DUPLICATE KEY UPDATE
     member_id = VALUES(member_id), type = VALUES(type),
     file_path = VALUES(file_path), file_name = VALUES(file_name),
     mime = VALUES(mime), size = VALUES(size),
     fba_shipment_id = VALUES(fba_shipment_id), destination_code = VALUES(destination_code),
     boxes = VALUES(boxes), status = VALUES(status),
     scan_result = VALUES(scan_result), photo_urls = VALUES(photo_urls),
     applied_at = VALUES(applied_at), verified_at = VALUES(verified_at),
     created_at = VALUES(created_at), updated_at = VALUES(updated_at),
     deleted_at = VALUES(deleted_at)',
  'SELECT ''send_order_labels SKIP: v2_send_order_label 不存在于本库'' AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. send_order_invoice_events（旧源 v2_send_order_invoice_event）
--    同样 PREPARE 条件跳过（本地无表）。append-only，无 updated_at。
-- ---------------------------------------------------------------------------
SET @src_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'v2_send_order_invoice_event'
);
SET @sql := IF(@src_exists > 0,
  'INSERT INTO send_order_invoice_events (
     id, send_order_id, member_id, type, invoice_version, comment, image_urls,
     source, ticket_id, created_at
   )
   SELECT e.id, e.sid, e.uid, e.type, e.invoice_version, NULLIF(e.comment, ''''),
     e.image_urls, e.source, e.ticket_id, e.created_at
   FROM v2_send_order_invoice_event e
   JOIN send_orders so ON so.id = e.sid
   ON DUPLICATE KEY UPDATE
     member_id = VALUES(member_id), type = VALUES(type),
     invoice_version = VALUES(invoice_version), comment = VALUES(comment),
     image_urls = VALUES(image_urls), source = VALUES(source),
     ticket_id = VALUES(ticket_id), created_at = VALUES(created_at)',
  'SELECT ''send_order_invoice_events SKIP: v2_send_order_invoice_event 不存在于本库'' AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 4. invoices（旧源 dg_fapiao；本地子集 29,238 行 / 生产 446 万行）
--
-- 字段转换要点：
--   · id == fid；sid/oid/uid 三维全 NOT NULL（源表口径，实测每单一发票）
--   · cid → address_book_id：0 → NULL（本地 78,344 行=0）
--   · airbill：# 多单号 → 首段入 airbill（≤64 断言见 0013），全量原值入 legacyExtra
--   · totalweight：含代码值（'A'）→ 字符串列禁转数值（Q2 拍板）
--   · exchangerate float(10,2) → Decimal(10,4)（防舍入丢失）
--   · 源表 39 个 NOT NULL varchar 实为空串常态 → 新表可空列 + NULLIF 清洗
--   · 会员/收件人快照列保留（历史事实），禁反查实时表
--   · 旧表无时间列 → created_at/updated_at 回填空置（新写入必须赋值）
--   · ⚠ 生产：按 fid 分片回填（每片 INSERT..SELECT..JOIN send_orders LIMIT），
--     禁一次性全量（446 万行 + 隧道长连接不稳教训）
-- ---------------------------------------------------------------------------
INSERT INTO invoices (
  id, send_order_id, order_id, member_id, address_book_id,
  member_name, member_tel, member_post, member_address,
  consignee_name, goods_rongji, consignee_tel, consignee_post, consignee_address,
  transport, airbill, total_weight, country, teams, packages,
  tariff, goods_international, amount, box_num, hy_box_num,
  goods_price, goods_name, goods_caizhi, goods_num, goods_url, goods_id, goods_img,
  order_weight, goods_total, subtotal, bargain_price, caizhi_memo, low_multiple,
  exp_cn_name, en_name, goods_useful, useful_memo,
  export_name, exchange_rate, sales_name, sales_tel, rate_type, send_price,
  package_name, package_id,
  created_at, updated_at, legacy_extra
)
SELECT
  f.fid,
  f.sid,
  f.oid,
  f.uid,
  NULLIF(f.cid, 0),
  NULLIF(f.uname, ''),
  NULLIF(f.utel, ''),
  NULLIF(f.upost, ''),
  NULLIF(f.uaddress, ''),
  NULLIF(f.cname, ''),
  NULLIF(f.goodsrongji, ''),
  NULLIF(f.ctel, ''),
  NULLIF(f.cpost, ''),
  NULLIF(f.caddress, ''),
  NULLIF(f.transport, ''),
  SUBSTRING_INDEX(f.airbill, '#', 1),
  NULLIF(f.totalweight, ''),
  NULLIF(f.country, ''),
  NULLIF(f.teams, ''),
  NULLIF(f.packages, ''),
  NULLIF(f.tariff, ''),
  NULLIF(f.goodsinternational, ''),
  f.amount,
  f.boxnum,
  NULLIF(f.hyboxnum, ''),
  f.goodsprice,
  NULLIF(f.goodsname, ''),
  NULLIF(f.goodscaizhi, ''),
  f.goodsnum,
  NULLIF(f.goodsurl, ''),
  NULLIF(f.goodsid, ''),
  NULLIF(f.goodsimg, ''),
  f.orderweight,
  f.goodstotal,
  f.subtotal,
  f.bargainprice,
  NULLIF(f.gcaizhimemo, ''),
  f.lowmultiple,
  NULLIF(f.expcnname, ''),
  NULLIF(f.enname, ''),
  NULLIF(f.goodsuseful, ''),
  NULLIF(f.gusefulmemo, ''),
  NULLIF(f.exportname, ''),
  f.exchangerate,
  NULLIF(f.salesname, ''),
  NULLIF(f.salestel, ''),
  f.ratetype,
  f.sendprice,
  NULLIF(f.packagename, ''),
  NULLIF(f.packageid, 0),
  NULL,
  NULL,
  CASE WHEN CHAR_LENGTH(f.airbill) > 64 THEN JSON_OBJECT('airbillRaw', f.airbill) END
FROM dg_fapiao f
JOIN send_orders so ON so.id = f.sid
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id),
  member_id = VALUES(member_id),
  address_book_id = VALUES(address_book_id),
  member_name = VALUES(member_name),
  member_tel = VALUES(member_tel),
  member_post = VALUES(member_post),
  member_address = VALUES(member_address),
  consignee_name = VALUES(consignee_name),
  goods_rongji = VALUES(goods_rongji),
  consignee_tel = VALUES(consignee_tel),
  consignee_post = VALUES(consignee_post),
  consignee_address = VALUES(consignee_address),
  transport = VALUES(transport),
  airbill = VALUES(airbill),
  total_weight = VALUES(total_weight),
  country = VALUES(country),
  teams = VALUES(teams),
  packages = VALUES(packages),
  tariff = VALUES(tariff),
  goods_international = VALUES(goods_international),
  amount = VALUES(amount),
  box_num = VALUES(box_num),
  hy_box_num = VALUES(hy_box_num),
  goods_price = VALUES(goods_price),
  goods_name = VALUES(goods_name),
  goods_caizhi = VALUES(goods_caizhi),
  goods_num = VALUES(goods_num),
  goods_url = VALUES(goods_url),
  goods_id = VALUES(goods_id),
  goods_img = VALUES(goods_img),
  order_weight = VALUES(order_weight),
  goods_total = VALUES(goods_total),
  subtotal = VALUES(subtotal),
  bargain_price = VALUES(bargain_price),
  caizhi_memo = VALUES(caizhi_memo),
  low_multiple = VALUES(low_multiple),
  exp_cn_name = VALUES(exp_cn_name),
  en_name = VALUES(en_name),
  goods_useful = VALUES(goods_useful),
  useful_memo = VALUES(useful_memo),
  export_name = VALUES(export_name),
  exchange_rate = VALUES(exchange_rate),
  sales_name = VALUES(sales_name),
  sales_tel = VALUES(sales_tel),
  rate_type = VALUES(rate_type),
  send_price = VALUES(send_price),
  package_name = VALUES(package_name),
  package_id = VALUES(package_id),
  legacy_extra = VALUES(legacy_extra);

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM invoices);
SET @sql := CONCAT('ALTER TABLE invoices AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 5. 完事快照
-- ---------------------------------------------------------------------------
SELECT 'send_order_value_added_services' AS tbl, COUNT(*) AS rows_now FROM send_order_value_added_services
UNION ALL SELECT 'send_order_labels', COUNT(*) FROM send_order_labels
UNION ALL SELECT 'send_order_invoice_events', COUNT(*) FROM send_order_invoice_events
UNION ALL SELECT 'invoices', COUNT(*) FROM invoices
UNION ALL SELECT 'dg_fapiao(src subset)', COUNT(*) FROM dg_fapiao;
