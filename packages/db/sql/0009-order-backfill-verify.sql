-- ============================================================================
-- T1 回填校验：order 域（跑完 0006→0002(member)→0007→0008 后执行）
--
-- 范式：每条断言返回**差异行**，结果集为空 = PASS；非空 = FAIL 需排查。
-- 末尾 §10 给汇总快照。全部只读，可反复执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 行数对齐：orders == dg_order ⋈ member（本地预期 72,312）
-- ---------------------------------------------------------------------------
SELECT 'A1 orders vs valid dg_order' AS assertion, COUNT(*) AS diff FROM (
  SELECT o.oid FROM dg_order o JOIN member m ON m.id = o.uid
  LEFT JOIN orders n ON n.id = o.oid WHERE n.id IS NULL
  UNION ALL
  SELECT n.id FROM orders n LEFT JOIN dg_order o ON o.oid = n.id WHERE o.oid IS NULL
) d;

-- ---------------------------------------------------------------------------
-- 2. 组数对齐：order_groups == distinct(tid≠'') + 空 tid 有效单数
-- ---------------------------------------------------------------------------
SELECT 'A2 group count' AS assertion,
  (SELECT COUNT(*) FROM order_groups) AS groups_now,
  (SELECT COUNT(*) FROM (SELECT DISTINCT tid FROM dg_order o JOIN member m ON m.id=o.uid WHERE o.tid<>'') t)
  + (SELECT COUNT(*) FROM dg_order o JOIN member m ON m.id=o.uid WHERE o.tid='') AS expected_groups;

-- ---------------------------------------------------------------------------
-- 3. 砍价总额对齐（Q5 口径核心）：SUM(order_groups.bargain_amount)
--    == SUM(dg_order.bargainprice)（有效会员范围内，tid 组 + 空 tid 单）
-- ---------------------------------------------------------------------------
SELECT 'A3 bargain total' AS assertion,
  (SELECT ROUND(SUM(bargain_amount), 2) FROM order_groups) AS groups_sum,
  (SELECT ROUND(SUM(o.bargainprice), 2) FROM dg_order o JOIN member m ON m.id = o.uid) AS source_sum;

-- ---------------------------------------------------------------------------
-- 4. 组级砍价逐组对比（应 0 行差异；分 tid 组 / 独立组两条，各走索引）
-- ---------------------------------------------------------------------------
SELECT 'A4a per-group bargain (tid)' AS assertion, g.id, g.tid, g.bargain_amount, s.src_sum
FROM order_groups g
JOIN (
  SELECT o.tid, SUM(o.bargainprice) AS src_sum
  FROM dg_order o JOIN member m ON m.id = o.uid
  WHERE o.tid <> '' GROUP BY o.tid
) s ON s.tid = g.tid
WHERE ABS(g.bargain_amount - s.src_sum) > 0.001;

SELECT 'A4b per-group bargain (standalone)' AS assertion, g.id, g.legacy_order_id, g.bargain_amount, o.bargainprice AS src_sum
FROM order_groups g
JOIN dg_order o ON o.oid = g.legacy_order_id
WHERE g.legacy_order_id IS NOT NULL
  AND ABS(g.bargain_amount - o.bargainprice) > 0.001;

-- ---------------------------------------------------------------------------
-- 5. 孤儿与悬挂：member_id 必须在 member；group_id 必须非空且组存在
-- ---------------------------------------------------------------------------
SELECT 'A5a orphan member_id' AS assertion, o.id, o.member_id
FROM orders o LEFT JOIN member m ON m.id = o.member_id WHERE m.id IS NULL;

SELECT 'A5b null group_id' AS assertion, o.id FROM orders o WHERE o.group_id IS NULL;

SELECT 'A5c dangling group_id' AS assertion, o.id, o.group_id
FROM orders o LEFT JOIN order_groups g ON g.id = o.group_id WHERE g.id IS NULL;

-- ---------------------------------------------------------------------------
-- 6. 分组正确性：tid 组的 orders.tid 来源必须与组 tid 一致
--    （空 tid 单：legacy_order_id == orders.id）
-- ---------------------------------------------------------------------------
SELECT 'A6a tid group mismatch' AS assertion, o.id, o.group_id
FROM orders o
JOIN order_groups g ON g.id = o.group_id
JOIN dg_order d ON d.oid = o.id
WHERE g.tid IS NOT NULL AND (d.tid = '' OR d.tid <> g.tid);

SELECT 'A6b standalone group mismatch' AS assertion, o.id, g.legacy_order_id
FROM orders o
JOIN order_groups g ON g.id = o.group_id
WHERE g.legacy_order_id IS NOT NULL AND g.legacy_order_id <> o.id;

-- ---------------------------------------------------------------------------
-- 7. 字段级抽查：随机 5 单逐列对比（金额/数量/状态/时间）
-- ---------------------------------------------------------------------------
SELECT 'A7 field-level sample' AS assertion, o.id,
  o.unit_price, d.goodsprice, o.bargained_unit_price, d.goodsprice1,
  o.shipping_fee, d.sendprice, o.purchase_unit_price, d.goodsuprice,
  o.quantity, d.goodsnum, o.status, d.state, o.created_at, FROM_UNIXTIME(d.addtime)
FROM orders o JOIN dg_order d ON d.oid = o.id
ORDER BY RAND() LIMIT 5;

-- ---------------------------------------------------------------------------
-- 8. 时间转换抽查：created_at 必须等于 FROM_UNIXTIME(addtime)（应 0 行）
-- ---------------------------------------------------------------------------
SELECT 'A8 addtime drift' AS assertion, o.id, o.created_at, FROM_UNIXTIME(d.addtime) AS expect
FROM orders o JOIN dg_order d ON d.oid = o.id
WHERE o.created_at <> FROM_UNIXTIME(NULLIF(d.addtime, 0))
  AND NOT (d.addtime IS NULL OR d.addtime = 0);

-- ---------------------------------------------------------------------------
-- 9. JSON 列合法性与语义抽查
-- ---------------------------------------------------------------------------
SELECT 'A9a invalid inspection_options' AS assertion, o.id
FROM orders o WHERE JSON_VALID(o.inspection_options) = 0;

SELECT 'A9b invalid legacy_state_times' AS assertion, o.id
FROM orders o WHERE o.legacy_state_times IS NOT NULL AND JSON_VALID(o.legacy_state_times) = 0;

-- is_after_sale 与 expressno _S 后缀一致（应 0 行）
SELECT 'A9c after_sale flag' AS assertion, o.id, o.domestic_tracking_no
FROM orders o JOIN dg_order d ON d.oid = o.id
WHERE o.is_after_sale <> (RIGHT(d.expressno, 2) = '_S');

-- mark_flag 拆包一致（应 0 行）
SELECT 'A9d mark_flag unpack' AS assertion, o.id, o.is_favorite, o.arrival_mark, d.mark_flag
FROM orders o JOIN dg_order d ON d.oid = o.id
WHERE o.is_favorite <> ((COALESCE(d.mark_flag, 0) & 3) = 1)
   OR o.arrival_mark <> ((COALESCE(d.mark_flag, 0) >> 2) & 3);

-- ---------------------------------------------------------------------------
-- 10. 状态分布对比（应完全一致）
-- ---------------------------------------------------------------------------
SELECT 'A10 status distribution' AS assertion,
  o.status, COUNT(*) AS orders_cnt,
  (SELECT COUNT(*) FROM dg_order d JOIN member m ON m.id = d.uid WHERE d.state = o.status) AS source_cnt
FROM orders o GROUP BY o.status ORDER BY o.status;

-- ---------------------------------------------------------------------------
-- 11. 侧表计数快照（与 0008 末快照对照；本地预期值见括号）
-- ---------------------------------------------------------------------------
SELECT 'A11 side tables' AS assertion, tbl, rows_now FROM (
  SELECT 'shops' AS tbl, COUNT(*) AS rows_now FROM shops
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
  UNION ALL SELECT 'cart_value_added_services', COUNT(*) FROM cart_value_added_services
  UNION ALL SELECT 'order_status_histories', COUNT(*) FROM order_status_histories
) t;

-- ---------------------------------------------------------------------------
-- 12. 侧表孤儿检查（应全 0）
-- ---------------------------------------------------------------------------
SELECT 'A12a ext orphan' AS assertion, COUNT(*) AS cnt FROM order_extensions e LEFT JOIN orders o ON o.id = e.order_id WHERE o.id IS NULL;
SELECT 'A12b msg orphan' AS assertion, COUNT(*) AS cnt FROM order_messages x LEFT JOIN orders o ON o.id = x.order_id WHERE o.id IS NULL;
SELECT 'A12c cart orphan' AS assertion, COUNT(*) AS cnt FROM carts c LEFT JOIN member m ON m.id = c.member_id WHERE m.id IS NULL;
SELECT 'A12d invalid_mark orphan' AS assertion, COUNT(*) AS cnt FROM order_invalid_marks v LEFT JOIN orders o ON o.id = v.order_id WHERE o.id IS NULL;
SELECT 'A12e sku_link orphan' AS assertion, COUNT(*) AS cnt FROM platform_sku_order_links l LEFT JOIN orders o ON o.id = l.order_id WHERE o.id IS NULL;
SELECT 'A12f exam_relation orphan' AS assertion, COUNT(*) AS cnt FROM order_examinations r LEFT JOIN orders o ON o.id = r.order_id WHERE o.id IS NULL;
SELECT 'A12g import_item orphan' AS assertion, COUNT(*) AS cnt FROM import_items i LEFT JOIN import_batches b ON b.id = i.batch_id WHERE b.id IS NULL;

-- ---------------------------------------------------------------------------
-- 13. AUTO_INCREMENT 顶到位（必须 > MAX(id)，否则新写入撞旧 id）
-- ---------------------------------------------------------------------------
SELECT 'A13 auto_increment' AS assertion, table_name, auto_increment FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name IN (
  'orders', 'order_groups', 'order_status_histories', 'shops', 'platform_orders',
  'platform_order_items', 'platform_products', 'platform_product_skus',
  'platform_sku_order_links', 'order_platform_creations', 'order_value_added_services',
  'order_splits', 'import_batches', 'import_items', 'order_invalid_marks',
  'order_messages', 'examination_records', 'order_examinations', 'carts',
  'cart_value_added_services', 'platform_sub_accounts'
) ORDER BY table_name;
