-- ============================================================================
-- T1 回填（第二批）：order 域 20 张侧表
--
-- 依赖序（先被引用的先回填）：
--   shops → platform_orders → platform_order_items
--        → platform_products → platform_product_skus → platform_sku_order_links
--   orders → order_extensions / order_platform_creations / order_value_added_services /
--            order_splits / order_invalid_marks / order_messages / order_examinations
--   member → import_batches → import_items / carts → cart_value_added_services
--   examination_records → order_examinations
--
-- 本地副本**不存在**源表、本批跳过的 4 张（生产执行时补相应段）：
--   · order_client_refs        ← v2_order_client_ref（PK=oid, uid, client_order_id）
--   · platform_trade_amounts   ← v2_platform_order_amount（first/latest 快照对）
--   · inquiry_orders / items   ← dg_inquiry_order(_item)
--
-- 纪律同 0007：只写新表 / ODKU 幂等 / 显式带 id / JOIN 过滤孤儿 /
--              FROM_UNIXTIME 转时间 / 禁写旧表。
-- ----------------------------------------------------------------------------
-- 价格 varchar 拆分口径（实测旧值形如 "2999 JPY"，空格分隔）：
--   amount   = SUBSTRING_INDEX(price, ' ', 1)
--   currency = SUBSTRING_INDEX(price, ' ', -1)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. shops ← v2_ecommerce_shop（uid → member_id；JOIN member 过滤孤儿店）
-- ---------------------------------------------------------------------------
INSERT INTO shops (
  id, member_id, platform, unique_id, name, url, marketplace_id, seller_id,
  api_credentials, currency, timezone, description, status, connection_status,
  last_verified_at, auth_expires_at, last_verified_status, last_verified_message,
  use_store, auto_sync_orders, last_sync_at,
  created_at, updated_at, deleted_at, restored_at, deleted_by_member_id, restored_by_member_id
)
SELECT
  s.id, s.uid, s.platform, s.unique_id, s.name, s.url, s.marketplace_id, s.seller_id,
  s.api_credentials, s.currency, s.timezone, s.description, s.status, s.connection_status,
  s.last_verified_at, s.auth_expires_at, s.last_verified_status, s.last_verified_message,
  s.use_store = 1, s.auto_sync_orders = 1, s.last_sync_at,
  s.created_at, s.updated_at, s.deleted_at, s.restored_at,
  s.deleted_by_uid, s.restored_by_uid
FROM v2_ecommerce_shop s
JOIN member m ON m.id = s.uid
ON DUPLICATE KEY UPDATE
  member_id = VALUES(member_id), platform = VALUES(platform), unique_id = VALUES(unique_id),
  name = VALUES(name), url = VALUES(url), marketplace_id = VALUES(marketplace_id),
  seller_id = VALUES(seller_id), api_credentials = VALUES(api_credentials),
  currency = VALUES(currency), timezone = VALUES(timezone), description = VALUES(description),
  status = VALUES(status), connection_status = VALUES(connection_status),
  last_verified_at = VALUES(last_verified_at), auth_expires_at = VALUES(auth_expires_at),
  last_verified_status = VALUES(last_verified_status),
  last_verified_message = VALUES(last_verified_message),
  use_store = VALUES(use_store), auto_sync_orders = VALUES(auto_sync_orders),
  last_sync_at = VALUES(last_sync_at), updated_at = VALUES(updated_at),
  deleted_at = VALUES(deleted_at), restored_at = VALUES(restored_at),
  deleted_by_member_id = VALUES(deleted_by_member_id),
  restored_by_member_id = VALUES(restored_by_member_id);

-- ---------------------------------------------------------------------------
-- 2. platform_sub_accounts ← v2_platform_sub_account（token 敏感；Q8 加密待核实）
-- ---------------------------------------------------------------------------
INSERT INTO platform_sub_accounts (
  id, appid, member_ref, out_user_id, username, account_type, token,
  created_at, updated_at, deleted_at
)
SELECT
  a.id, a.appid, a.member_id, a.out_user_id, a.username, a.type, a.token,
  a.created_at, a.updated_at, a.deleted_at
FROM v2_platform_sub_account a
ON DUPLICATE KEY UPDATE
  appid = VALUES(appid), member_ref = VALUES(member_ref), out_user_id = VALUES(out_user_id),
  username = VALUES(username), account_type = VALUES(account_type), token = VALUES(token),
  updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 3. platform_orders ← v2_ecommerce_order（JOIN shops；price varchar 拆分）
--    注意：v2_ecommerce_order **无 uid 列**——会员关联发生在 confirm 转单时
-- ---------------------------------------------------------------------------
INSERT INTO platform_orders (
  id, shop_id, unique_id, platform_order_sn, platform_order_status, platform_modified_at,
  detail, status, is_fulfilled, fulfillment_failure_reason,
  total_amount, currency, shipping_info, ordered_at,
  created_at, updated_at, deleted_at
)
SELECT
  e.id, e.shop_id, e.unique_id, e.platform_order_sn, e.platform_order_status, e.platform_modified_at,
  e.detail, e.order_status, e.is_fulfilled = 1, e.fulfillment_failure_reason,
  CAST(SUBSTRING_INDEX(e.price, ' ', 1) AS DECIMAL(14, 2)),
  SUBSTRING_INDEX(e.price, ' ', -1),
  e.shipping_info, e.ordered_at,
  e.created_at, e.updated_at, e.deleted_at
FROM v2_ecommerce_order e
JOIN shops sh ON sh.id = e.shop_id
ON DUPLICATE KEY UPDATE
  shop_id = VALUES(shop_id), unique_id = VALUES(unique_id),
  platform_order_sn = VALUES(platform_order_sn),
  platform_order_status = VALUES(platform_order_status),
  platform_modified_at = VALUES(platform_modified_at), detail = VALUES(detail),
  status = VALUES(status), is_fulfilled = VALUES(is_fulfilled),
  fulfillment_failure_reason = VALUES(fulfillment_failure_reason),
  total_amount = VALUES(total_amount), currency = VALUES(currency),
  shipping_info = VALUES(shipping_info), ordered_at = VALUES(ordered_at),
  updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 4. platform_order_items ← v2_ecommerce_order_item（JOIN platform_orders；双价拆分）
-- ---------------------------------------------------------------------------
INSERT INTO platform_order_items (
  id, order_id, sku_id, unique_id, quantity,
  unit_price, unit_currency, total_price, total_currency,
  product_snapshot, created_at, updated_at, deleted_at
)
SELECT
  i.id, i.order_id, i.sku_id, i.unique_id, i.num,
  CAST(SUBSTRING_INDEX(i.unit_price, ' ', 1) AS DECIMAL(14, 2)),
  SUBSTRING_INDEX(i.unit_price, ' ', -1),
  CAST(SUBSTRING_INDEX(i.total_price, ' ', 1) AS DECIMAL(14, 2)),
  SUBSTRING_INDEX(i.total_price, ' ', -1),
  i.product_snapshot, i.created_at, i.updated_at, i.deleted_at
FROM v2_ecommerce_order_item i
JOIN platform_orders po ON po.id = i.order_id
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), sku_id = VALUES(sku_id), unique_id = VALUES(unique_id),
  quantity = VALUES(quantity), unit_price = VALUES(unit_price),
  unit_currency = VALUES(unit_currency), total_price = VALUES(total_price),
  total_currency = VALUES(total_currency), product_snapshot = VALUES(product_snapshot),
  updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 5. platform_products ← v2_ecommerce_product（JOIN shops）
-- ---------------------------------------------------------------------------
INSERT INTO platform_products (
  id, shop_id, unique_id, name, goods_url, img_url, platform_status,
  created_at, updated_at, deleted_at
)
SELECT
  p.id, p.shop_id, p.unique_id, p.name, p.goods_url, p.img_url, p.platform_status,
  p.created_at, p.updated_at, p.deleted_at
FROM v2_ecommerce_product p
JOIN shops sh ON sh.id = p.shop_id
ON DUPLICATE KEY UPDATE
  shop_id = VALUES(shop_id), unique_id = VALUES(unique_id), name = VALUES(name),
  goods_url = VALUES(goods_url), img_url = VALUES(img_url),
  platform_status = VALUES(platform_status), updated_at = VALUES(updated_at),
  deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 6. platform_product_skus ← v2_ecommerce_product_sku（JOIN platform_products）
-- ---------------------------------------------------------------------------
INSERT INTO platform_product_skus (
  id, shop_id, product_id, unique_id, sku, fnsku, name, img_url,
  attribute, price, platform_inventory, created_at, updated_at, deleted_at
)
SELECT
  k.id, k.shop_id, k.product_id, k.unique_id, k.sku, k.fnsku, k.name, k.img_url,
  k.attribute, k.price, k.platform_inventory, k.created_at, k.updated_at, k.deleted_at
FROM v2_ecommerce_product_sku k
JOIN platform_products pp ON pp.id = k.product_id
ON DUPLICATE KEY UPDATE
  shop_id = VALUES(shop_id), product_id = VALUES(product_id), unique_id = VALUES(unique_id),
  sku = VALUES(sku), fnsku = VALUES(fnsku), name = VALUES(name), img_url = VALUES(img_url),
  attribute = VALUES(attribute), price = VALUES(price),
  platform_inventory = VALUES(platform_inventory), updated_at = VALUES(updated_at),
  deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 7. platform_sku_order_links ← v2_relation_ecommerce_product_sku_and_order
--    （JOIN orders + platform_product_skus 双过滤；UK (sku_id, order_id)）
-- ---------------------------------------------------------------------------
INSERT INTO platform_sku_order_links (id, order_id, sku_id, created_at, updated_at)
SELECT r.id, r.oid, r.ecommerce_product_sku_id, r.created_at, r.updated_at
FROM v2_relation_ecommerce_product_sku_and_order r
JOIN orders o ON o.id = r.oid
JOIN platform_product_skus k ON k.id = r.ecommerce_product_sku_id
ON DUPLICATE KEY UPDATE order_id = VALUES(order_id), sku_id = VALUES(sku_id),
  updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 8. order_extensions ← v2_order_detail（PK 即 oid；JOIN orders）
-- ---------------------------------------------------------------------------
INSERT INTO order_extensions (
  order_id, goods_name_trans, sku_trans, coupon_fee, seller_change_amount,
  instant_chat_tag, created_at, updated_at
)
SELECT
  d.id, d.goods_name_trans, d.sku_trans, d.coupon_fee, d.seller_change_amount,
  d.instant_chat_tag, d.created_at, d.updated_at
FROM v2_order_detail d
JOIN orders o ON o.id = d.id
ON DUPLICATE KEY UPDATE
  goods_name_trans = VALUES(goods_name_trans), sku_trans = VALUES(sku_trans),
  coupon_fee = VALUES(coupon_fee), seller_change_amount = VALUES(seller_change_amount),
  instant_chat_tag = VALUES(instant_chat_tag), updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 9. order_platform_creations ← v2_order_auto_created（JOIN orders；
--    type 1=1688 2=taobao_global；add_from 0=auto 1=manual）
-- ---------------------------------------------------------------------------
INSERT INTO order_platform_creations (
  id, order_id, platform, creation_mode, platform_sub_account_id,
  platform_trade_id, platform_sub_trade_id, created_at, updated_at
)
SELECT
  c.id, c.oid,
  CASE c.type WHEN 1 THEN '1688' WHEN 2 THEN 'taobao_global' ELSE CONCAT('unknown_', c.type) END,
  CASE c.add_from WHEN 1 THEN 'manual' ELSE 'auto' END,
  c.platform_sub_account_id, c.platform_trade_id, c.platform_sub_trade_id,
  c.created_at, c.updated_at
FROM v2_order_auto_created c
JOIN orders o ON o.id = c.oid
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), platform = VALUES(platform),
  creation_mode = VALUES(creation_mode),
  platform_sub_account_id = VALUES(platform_sub_account_id),
  platform_trade_id = VALUES(platform_trade_id),
  platform_sub_trade_id = VALUES(platform_sub_trade_id),
  updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 10. order_value_added_services ← v2_order_value_added_service（JOIN orders）
-- ---------------------------------------------------------------------------
INSERT INTO order_value_added_services (
  id, order_id, service_id, name_snapshot, remark, unit_price, qty, fee,
  created_at, updated_at
)
SELECT
  v.id, v.oid, v.service_id, v.name_snapshot, v.remark, v.unit_price, v.qty, v.fee,
  v.created_at, v.updated_at
FROM v2_order_value_added_service v
JOIN orders o ON o.id = v.oid
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), service_id = VALUES(service_id),
  name_snapshot = VALUES(name_snapshot), remark = VALUES(remark),
  unit_price = VALUES(unit_price), qty = VALUES(qty), fee = VALUES(fee),
  updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 11. order_splits ← dg_order_split（oid 与 spoid 双侧 JOIN orders）
-- ---------------------------------------------------------------------------
INSERT INTO order_splits (id, order_id, split_from_order_id, quantity, member_id, created_at)
SELECT
  s.id, s.oid, s.spoid, s.goodsnum, s.uid, FROM_UNIXTIME(NULLIF(s.addtime, 0))
FROM dg_order_split s
JOIN orders o ON o.id = s.oid
LEFT JOIN orders so ON so.id = s.spoid
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), split_from_order_id = VALUES(split_from_order_id),
  quantity = VALUES(quantity), member_id = VALUES(member_id);

-- ---------------------------------------------------------------------------
-- 12. import_batches ← dg_imporder（JOIN member；addtime/uptime 转 DATETIME）
-- ---------------------------------------------------------------------------
INSERT INTO import_batches (
  id, member_id, type, status, memo, file_name, notify_state,
  created_at, updated_at, deleted_at
)
SELECT
  b.id, b.uid, b.type, b.state, b.memo, b.filename, b.notify_state,
  FROM_UNIXTIME(NULLIF(b.addtime, 0)), FROM_UNIXTIME(NULLIF(b.uptime, 0)), b.deleted_at
FROM dg_imporder b
JOIN member m ON m.id = b.uid
ON DUPLICATE KEY UPDATE
  member_id = VALUES(member_id), type = VALUES(type), status = VALUES(status),
  memo = VALUES(memo), file_name = VALUES(file_name), notify_state = VALUES(notify_state),
  updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 13. import_items ← dg_imporder_detail（JOIN import_batches）
-- ---------------------------------------------------------------------------
INSERT INTO import_items (
  id, batch_id, member_id, type, goods_url, goods_name, goods_id, supplier_product_id,
  goods_img, goods_site, unit_price, quantity, sku_name, color, size, seller,
  remark, order_remark, consignee, tel, zip, address, out_id, status, pro_info,
  ordered_at, order_id, data_from, max_price, original_order_id,
  created_at, deleted_at
)
SELECT
  d.id, d.impid, d.uid, d.type, d.goodsurl, d.goodsname, d.goodsid, d.supplier_product_id,
  d.goodsimg, d.goodssite, d.goodsprice, d.goodsnum, d.sku_name, d.goodscolor,
  d.goodssize, d.goodsseller, d.goodsremark, d.orderremark,
  d.dfsendname, d.dfsendtel, d.dfsendzip, d.dfsendaddress,
  d.outid, d.state, d.pro_info,
  FROM_UNIXTIME(NULLIF(d.ordertime, 0)), d.oid, d.datafrom, d.maxprice, d.original_oid,
  FROM_UNIXTIME(NULLIF(d.addtime, 0)), d.deleted_at
FROM dg_imporder_detail d
JOIN import_batches b ON b.id = d.impid
ON DUPLICATE KEY UPDATE
  batch_id = VALUES(batch_id), member_id = VALUES(member_id), type = VALUES(type),
  goods_url = VALUES(goods_url), goods_name = VALUES(goods_name), goods_id = VALUES(goods_id),
  supplier_product_id = VALUES(supplier_product_id), goods_img = VALUES(goods_img),
  goods_site = VALUES(goods_site), unit_price = VALUES(unit_price),
  quantity = VALUES(quantity), sku_name = VALUES(sku_name), color = VALUES(color),
  size = VALUES(size), seller = VALUES(seller), remark = VALUES(remark),
  order_remark = VALUES(order_remark), consignee = VALUES(consignee), tel = VALUES(tel),
  zip = VALUES(zip), address = VALUES(address), out_id = VALUES(out_id),
  status = VALUES(status), pro_info = VALUES(pro_info), ordered_at = VALUES(ordered_at),
  order_id = VALUES(order_id), data_from = VALUES(data_from), max_price = VALUES(max_price),
  original_order_id = VALUES(original_order_id), deleted_at = VALUES(deleted_at);

-- ---------------------------------------------------------------------------
-- 14. order_invalid_marks ← dg_invalid_order（JOIN orders）
-- ---------------------------------------------------------------------------
INSERT INTO order_invalid_marks (id, order_id, admin_id, type, item_id, status, extra, memo, created_at, updated_at)
SELECT
  v.id, v.oid, v.admin_id, v.type, v.item_id, v.status, v.extra, v.memo,
  v.created_at, v.updated_at
FROM dg_invalid_order v
JOIN orders o ON o.id = v.oid
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), admin_id = VALUES(admin_id), type = VALUES(type),
  item_id = VALUES(item_id), status = VALUES(status), extra = VALUES(extra),
  memo = VALUES(memo), updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 15. order_messages ← dg_yunjiao（JOIN orders；本地 177,921 行）
-- ---------------------------------------------------------------------------
INSERT INTO order_messages (
  id, order_id, member_id, status, box_no, assignee, operator,
  user_content, admin_content, images, is_focused, is_user_focused, created_at
)
SELECT
  y.jid, y.oid, y.uid, y.status, y.xbox, y.xz, y.user,
  y.ucon, y.xcon, y.images, y.is_focus = 1, y.user_focus = 1,
  FROM_UNIXTIME(NULLIF(y.addtime, 0))
FROM dg_yunjiao y
JOIN orders o ON o.id = y.oid
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), member_id = VALUES(member_id), status = VALUES(status),
  box_no = VALUES(box_no), assignee = VALUES(assignee), operator = VALUES(operator),
  user_content = VALUES(user_content), admin_content = VALUES(admin_content),
  images = VALUES(images), is_focused = VALUES(is_focused),
  is_user_focused = VALUES(is_user_focused);

-- ---------------------------------------------------------------------------
-- 16. examination_records ← dg_examination_record（无强依赖；oid 可空原样保留）
-- ---------------------------------------------------------------------------
INSERT INTO examination_records (
  id, order_id, tid, domestic_tracking_no, order_type, item_id, creator_id,
  salesman, reason, detail, detail_ja, images, status, extra, memo,
  created_at, updated_at
)
SELECT
  e.id, e.oid, e.tid, e.expressno, e.order_type, e.item_id, e.creator_id,
  e.salesman, e.reason, e.detail, e.detail_ja, e.images, e.status, e.extra, e.memo,
  e.created_at, e.updated_at
FROM dg_examination_record e
ON DUPLICATE KEY UPDATE
  order_id = VALUES(order_id), tid = VALUES(tid),
  domestic_tracking_no = VALUES(domestic_tracking_no), order_type = VALUES(order_type),
  item_id = VALUES(item_id), creator_id = VALUES(creator_id), salesman = VALUES(salesman),
  reason = VALUES(reason), detail = VALUES(detail), detail_ja = VALUES(detail_ja),
  images = VALUES(images), status = VALUES(status), extra = VALUES(extra),
  memo = VALUES(memo), updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 17. order_examinations ← relation_order_and_examination_record（双侧 JOIN）
-- ---------------------------------------------------------------------------
INSERT INTO order_examinations (id, order_id, examination_id, created_at, updated_at)
SELECT r.id, r.oid, r.examination_id, r.created_at, r.updated_at
FROM relation_order_and_examination_record r
JOIN orders o ON o.id = r.oid
JOIN examination_records e ON e.id = r.examination_id
ON DUPLICATE KEY UPDATE order_id = VALUES(order_id), examination_id = VALUES(examination_id),
  updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 18. carts ← dg_cart（JOIN member；三价 float→Decimal；检品列同 Order 收敛）
-- ---------------------------------------------------------------------------
INSERT INTO carts (
  id, member_id, type, tid,
  goods_id, goods_url, goods_name, goods_img, sku_name, goods_size, goods_color,
  goods_seller, seller_url, goods_site, site_url, supplier_product_id, domestic_tracking_no,
  quantity, unit_price, offer_price, retail_price, one_piece_price, shipping_fee,
  promo_price, inspection_fee, min_order_quantity,
  goods_name_trans, sku_trans,
  terms, ship_method, inspection_options, asin, fnsku,
  out_id, add_from, add_from_memo, client_ref, remark, created_at
)
SELECT
  c.gid, c.uid, c.type, c.tid,
  c.goodsid, c.goodsurl, c.goodsname, c.goodsimg, c.sku_name, c.goodssize, c.goodscolor,
  c.goodsseller, c.sellerurl, c.goodssite, c.siteurl, c.supplier_product_id, c.expressno,
  c.goodsnum, c.goodsprice, c.offer_price, c.retail_price, c.one_piece_price, c.sendprice,
  c.proprice, c.inspection, c.min_order_quantity,
  c.goods_name_trans, c.sku_trans,
  JSON_OBJECT(
    'qtyShortBuy', c.TermQty = 'Y',
    'priceAdjust', c.TermPrice = 'Y',
    'shippingAdjust', c.TermShipping = 'Y'
  ),
  c.ship,
  JSON_OBJECT(
    'var1', NULLIF(c.var1, ''), 'var2', NULLIF(c.var2, ''), 'var3', NULLIF(c.var3, ''),
    'var4', NULLIF(c.var4, ''), 'var5', NULLIF(c.var5, ''), 'var6', NULLIF(c.var6, ''),
    'var7', NULLIF(c.var7, ''), 'var8', NULLIF(c.var8, ''), 'var9', NULLIF(c.var9, ''),
    'var10', NULLIF(c.var10, ''), 'var11', NULLIF(c.var11, ''), 'var12', NULLIF(c.var12, ''),
    'yanhuofba', NULLIF(c.yanhuofba, ''), 'yanhuojinyun', NULLIF(c.yanhuojinyun, ''),
    'yanhuozengzhi', NULLIF(c.yanhuozengzhi, ''), 'yanhuoasin', NULLIF(c.yanhuoasin, ''),
    'yanhuofnsku', NULLIF(c.yanhuofnsku, ''),
    'baozhuang', NULLIF(c.baozhuang, ''), 'hbbaozhuang', NULLIF(c.hbbaozhuang, ''),
    'baonum', NULLIF(c.baonum, ''),
    'SKU', NULLIF(c.SKU, ''), 'shangpin_sku', NULLIF(c.shangpin_sku, ''),
    'FNSKU', NULLIF(c.FNSKU, ''), 'shangpin_fnsku', NULLIF(c.shangpin_fnsku, ''),
    'name', NULLIF(c.name, ''), 'shangpin_name', NULLIF(c.shangpin_name, ''),
    'amazon', NULLIF(c.amazon, ''), 'shangpin_amazon', NULLIF(c.shangpin_amazon, ''),
    'putong', NULLIF(c.putong, ''), 'fuzhuang', NULLIF(c.fuzhuang, ''),
    'tiebiao', NULLIF(c.tiebiao, ''), 'huanbaoz', NULLIF(c.huanbaoz, ''),
    'qita', NULLIF(c.qita, '')
  ),
  NULLIF(c.yanhuoasin, ''),
  NULLIF(c.yanhuofnsku, ''),
  c.outid, c.add_from, NULLIF(c.add_from_memo, ''), c.anonymous, c.goodsremark,
  FROM_UNIXTIME(NULLIF(c.addtime, 0))
FROM dg_cart c
JOIN member m ON m.id = c.uid
ON DUPLICATE KEY UPDATE
  member_id = VALUES(member_id), type = VALUES(type), tid = VALUES(tid),
  goods_id = VALUES(goods_id), goods_url = VALUES(goods_url), goods_name = VALUES(goods_name),
  goods_img = VALUES(goods_img), sku_name = VALUES(sku_name), goods_size = VALUES(goods_size),
  goods_color = VALUES(goods_color), goods_seller = VALUES(goods_seller),
  seller_url = VALUES(seller_url), goods_site = VALUES(goods_site), site_url = VALUES(site_url),
  supplier_product_id = VALUES(supplier_product_id),
  domestic_tracking_no = VALUES(domestic_tracking_no),
  quantity = VALUES(quantity), unit_price = VALUES(unit_price), offer_price = VALUES(offer_price),
  retail_price = VALUES(retail_price), one_piece_price = VALUES(one_piece_price),
  shipping_fee = VALUES(shipping_fee), promo_price = VALUES(promo_price),
  inspection_fee = VALUES(inspection_fee), min_order_quantity = VALUES(min_order_quantity),
  goods_name_trans = VALUES(goods_name_trans), sku_trans = VALUES(sku_trans),
  terms = VALUES(terms), ship_method = VALUES(ship_method),
  inspection_options = VALUES(inspection_options), asin = VALUES(asin), fnsku = VALUES(fnsku),
  out_id = VALUES(out_id), add_from = VALUES(add_from), add_from_memo = VALUES(add_from_memo),
  client_ref = VALUES(client_ref), remark = VALUES(remark);

-- ---------------------------------------------------------------------------
-- 19. cart_value_added_services ← v2_cart_value_added_service（JOIN carts）
-- ---------------------------------------------------------------------------
INSERT INTO cart_value_added_services (
  id, cart_id, service_id, name_snapshot, remark, unit_price, qty, fee,
  created_at, updated_at
)
SELECT
  v.id, v.cart_id, v.service_id, v.name_snapshot, v.remark, v.unit_price, v.qty, v.fee,
  v.created_at, v.updated_at
FROM v2_cart_value_added_service v
JOIN carts c ON c.id = v.cart_id
ON DUPLICATE KEY UPDATE
  cart_id = VALUES(cart_id), service_id = VALUES(service_id),
  name_snapshot = VALUES(name_snapshot), remark = VALUES(remark),
  unit_price = VALUES(unit_price), qty = VALUES(qty), fee = VALUES(fee),
  updated_at = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 20. 顶 AUTO_INCREMENT（全部保留旧 id 的表）
-- ---------------------------------------------------------------------------
SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM shops);
SET @sql := CONCAT('ALTER TABLE shops AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM platform_sub_accounts);
SET @sql := CONCAT('ALTER TABLE platform_sub_accounts AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM platform_orders);
SET @sql := CONCAT('ALTER TABLE platform_orders AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM platform_order_items);
SET @sql := CONCAT('ALTER TABLE platform_order_items AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM platform_products);
SET @sql := CONCAT('ALTER TABLE platform_products AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM platform_product_skus);
SET @sql := CONCAT('ALTER TABLE platform_product_skus AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM platform_sku_order_links);
SET @sql := CONCAT('ALTER TABLE platform_sku_order_links AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_platform_creations);
SET @sql := CONCAT('ALTER TABLE order_platform_creations AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_value_added_services);
SET @sql := CONCAT('ALTER TABLE order_value_added_services AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_splits);
SET @sql := CONCAT('ALTER TABLE order_splits AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM import_batches);
SET @sql := CONCAT('ALTER TABLE import_batches AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM import_items);
SET @sql := CONCAT('ALTER TABLE import_items AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_invalid_marks);
SET @sql := CONCAT('ALTER TABLE order_invalid_marks AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_messages);
SET @sql := CONCAT('ALTER TABLE order_messages AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM examination_records);
SET @sql := CONCAT('ALTER TABLE examination_records AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_examinations);
SET @sql := CONCAT('ALTER TABLE order_examinations AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM carts);
SET @sql := CONCAT('ALTER TABLE carts AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM cart_value_added_services);
SET @sql := CONCAT('ALTER TABLE cart_value_added_services AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 21. 完事快照
-- ---------------------------------------------------------------------------
SELECT 'shops' AS tbl, COUNT(*) AS rows_now FROM shops
UNION ALL SELECT 'platform_sub_accounts', COUNT(*) FROM platform_sub_accounts
UNION ALL SELECT 'platform_orders', COUNT(*) FROM platform_orders
UNION ALL SELECT 'platform_order_items', COUNT(*) FROM platform_order_items
UNION ALL SELECT 'platform_products', COUNT(*) FROM platform_products
UNION ALL SELECT 'platform_product_skus', COUNT(*) FROM platform_product_skus
UNION ALL SELECT 'platform_sku_order_links', COUNT(*) FROM platform_sku_order_links
UNION ALL SELECT 'order_extensions', COUNT(*) FROM order_extensions
UNION ALL SELECT 'order_platform_creations', COUNT(*) FROM order_platform_creations
UNION ALL SELECT 'order_value_added_services', COUNT(*) FROM order_value_added_services
UNION ALL SELECT 'order_splits', COUNT(*) FROM order_splits
UNION ALL SELECT 'import_batches', COUNT(*) FROM import_batches
UNION ALL SELECT 'import_items', COUNT(*) FROM import_items
UNION ALL SELECT 'order_invalid_marks', COUNT(*) FROM order_invalid_marks
UNION ALL SELECT 'order_messages', COUNT(*) FROM order_messages
UNION ALL SELECT 'examination_records', COUNT(*) FROM examination_records
UNION ALL SELECT 'order_examinations', COUNT(*) FROM order_examinations
UNION ALL SELECT 'carts', COUNT(*) FROM carts
UNION ALL SELECT 'cart_value_added_services', COUNT(*) FROM cart_value_added_services;
