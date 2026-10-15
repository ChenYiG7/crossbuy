-- ============================================================================
-- T1 回填校验断言：send-order 域（对应 order 域 0009）
--
-- 判定规则（与 0009 一致）：
--   · 行数/金额对齐类断言：输出 now == expected 两列，人工比对（脚本不中断）
--   · 差异明细类断言（B7/B9/B12/B14/B16）：**输出行数必须为 0**
--   · B1-B6/B8/B10/B11/B13/B15：now 列与 expected 列相等即 PASS
--
-- ⚠ 本地演练前置：0010 + 0011 + 0012 已执行。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- B1 send_orders 行数 == 有效运单基线（dg_sendorder JOIN member）
-- ---------------------------------------------------------------------------
SELECT 'B1 sendorder count' AS assertion,
  (SELECT COUNT(*) FROM send_orders) AS now_cnt,
  (SELECT COUNT(*) FROM dg_sendorder s JOIN member m ON m.id = s.uid) AS expected;

-- ---------------------------------------------------------------------------
-- B2 sid 主键对齐：新表 id 集合与源 sid 集合一致（差集行数必须为 0）
-- ---------------------------------------------------------------------------
SELECT 'B2 sid alignment' AS assertion, s.sid
FROM dg_sendorder s
JOIN member m ON m.id = s.uid
LEFT JOIN send_orders so ON so.id = s.sid
WHERE so.id IS NULL;

-- ---------------------------------------------------------------------------
-- B3 orders.send_order_id 单侧关联（oids 双写废除后的校正）：
--    a) 非空 send_order_id 的 orders 行数 == dg_order 中 sid 数字非零且命中的行数
--    b) 悬空引用必须为 0（send_order_id 指向不存在的 send_orders）
-- ---------------------------------------------------------------------------
SELECT 'B3a orders linked' AS assertion,
  (SELECT COUNT(*) FROM orders WHERE send_order_id IS NOT NULL) AS now_cnt,
  (SELECT COUNT(*) FROM dg_order d
     JOIN send_orders so ON so.id = CASE WHEN d.sid REGEXP '^[0-9]+$' AND d.sid <> '0' THEN CAST(d.sid AS SIGNED) END) AS expected;

SELECT 'B3b dangling send_order_id' AS assertion, o.id, o.send_order_id
FROM orders o
LEFT JOIN send_orders so ON so.id = o.send_order_id
WHERE o.send_order_id IS NOT NULL AND so.id IS NULL;

-- ---------------------------------------------------------------------------
-- B4 五费分列总额对齐（totalfee 禁信历史值的替代校验）：
--    SUM(国际+增值+报关+偏远+国内) == 源五费之和（有效会员范围）
-- ---------------------------------------------------------------------------
SELECT 'B4 five fees total' AS assertion,
  (SELECT ROUND(SUM(international_freight + service_fee + customs_fee + remote_fee + domestic_shipping_fee), 2) FROM send_orders) AS now_sum,
  (SELECT ROUND(SUM(COALESCE(s.freight,0) + COALESCE(s.serverfee,0) + COALESCE(s.customsfee,0) + COALESCE(s.remotefee,0) + COALESCE(s.sendprice,0)), 2)
     FROM dg_sendorder s JOIN member m ON m.id = s.uid) AS expected;

-- ---------------------------------------------------------------------------
-- B5 保险费独立列对齐（禁并入 totalfee 的对账口径）
-- ---------------------------------------------------------------------------
SELECT 'B5 insurance total' AS assertion,
  (SELECT ROUND(SUM(insurance_fee), 2) FROM send_orders) AS now_sum,
  (SELECT ROUND(SUM(COALESCE(s.Insurancefee, 0)), 2) FROM dg_sendorder s JOIN member m ON m.id = s.uid) AS expected;

-- ---------------------------------------------------------------------------
-- B6 运单砍价汇总 + 返金状态对齐
-- ---------------------------------------------------------------------------
SELECT 'B6a bargain total' AS assertion,
  (SELECT ROUND(SUM(bargain_amount), 2) FROM send_orders) AS now_sum,
  (SELECT ROUND(SUM(COALESCE(s.bargainprice, 0)), 2) FROM dg_sendorder s JOIN member m ON m.id = s.uid) AS expected;

SELECT 'B6b bargain refunded' AS assertion,
  (SELECT COUNT(*) FROM send_orders WHERE bargain_refunded) AS now_cnt,
  (SELECT COUNT(*) FROM dg_sendorder s JOIN member m ON m.id = s.uid WHERE s.bargainstate = 1) AS expected;

-- ---------------------------------------------------------------------------
-- B7 sn 长度断言：CHAR_LENGTH(sn) <= 64 全表必须成立（Q10 收紧）
-- ---------------------------------------------------------------------------
SELECT 'B7 sn length <= 64' AS assertion, id, CHAR_LENGTH(sn) AS len
FROM send_orders WHERE CHAR_LENGTH(sn) > 64;

-- ---------------------------------------------------------------------------
-- B8 snExtra 多单号拆分：非空 snExtra 行数 == 源 '#' 多单号行数
-- ---------------------------------------------------------------------------
SELECT 'B8 snExtra count' AS assertion,
  (SELECT COUNT(*) FROM send_orders WHERE sn_extra IS NOT NULL) AS now_cnt,
  (SELECT COUNT(*) FROM dg_sendorder s JOIN member m ON m.id = s.uid WHERE s.sn LIKE '%#%') AS expected;

-- ---------------------------------------------------------------------------
-- B9 invoices 行数 + fid 对齐 + 悬空（差异行必须为 0）
-- ---------------------------------------------------------------------------
SELECT 'B9a invoice count' AS assertion,
  (SELECT COUNT(*) FROM invoices) AS now_cnt,
  (SELECT COUNT(*) FROM dg_fapiao f JOIN send_orders so ON so.id = f.sid) AS expected;

SELECT 'B9b fid alignment' AS assertion, f.fid
FROM dg_fapiao f
JOIN send_orders so ON so.id = f.sid
LEFT JOIN invoices i ON i.id = f.fid
WHERE i.id IS NULL;

SELECT 'B9c dangling invoice sid' AS assertion, i.id, i.send_order_id
FROM invoices i
LEFT JOIN send_orders so ON so.id = i.send_order_id
WHERE so.id IS NULL;

-- ---------------------------------------------------------------------------
-- B10 增值服务行数对齐
-- ---------------------------------------------------------------------------
SELECT 'B10 vas count' AS assertion,
  (SELECT COUNT(*) FROM send_order_value_added_services) AS now_cnt,
  (SELECT COUNT(*) FROM v2_sendorder_value_added_service v JOIN send_orders so ON so.id = v.sid) AS expected;

-- ---------------------------------------------------------------------------
-- B11 状态历史：每个运单恰好一条 kind='state' 初始行
-- ---------------------------------------------------------------------------
SELECT 'B11 history count' AS assertion,
  (SELECT COUNT(*) FROM send_order_status_histories WHERE kind = 'state') AS now_cnt,
  (SELECT COUNT(*) FROM send_orders) AS expected;

-- ---------------------------------------------------------------------------
-- B12 状态分布对齐（8 态逐态比对；差异行必须为 0）
-- ---------------------------------------------------------------------------
SELECT 'B12 status distribution' AS assertion, n.status, n.cnt AS now_cnt, s.cnt AS src_cnt
FROM (SELECT status, COUNT(*) AS cnt FROM send_orders GROUP BY status) n
LEFT JOIN (
  SELECT COALESCE(s.state, 1) AS status, COUNT(*) AS cnt
  FROM dg_sendorder s JOIN member m ON m.id = s.uid GROUP BY COALESCE(s.state, 1)
) s ON s.status = n.status
WHERE NOT (n.cnt <=> s.cnt);

-- ---------------------------------------------------------------------------
-- B13 计费重解析抽查：'1.1' → 1100 克类样例（本地数值型 2,804 行）
-- ---------------------------------------------------------------------------
SELECT 'B13 chargeable weight' AS assertion,
  (SELECT COUNT(*) FROM send_orders WHERE chargeable_weight_grams IS NOT NULL) AS parsed,
  (SELECT COUNT(*) FROM dg_sendorder s JOIN member m ON m.id = s.uid
     WHERE s.countweight REGEXP '^[0-9]+(\.[0-9]+)?$') AS expected,
  (SELECT chargeable_weight_grams FROM send_orders WHERE chargeable_weight_grams > 0 LIMIT 1) AS sample;

-- ---------------------------------------------------------------------------
-- B14 memberId 悬空必须为 0（JOIN member 过滤铁律的回归断言）
-- ---------------------------------------------------------------------------
SELECT 'B14 member orphan' AS assertion, so.id, so.member_id
FROM send_orders so
LEFT JOIN member m ON m.id = so.member_id
WHERE m.id IS NULL;

-- ---------------------------------------------------------------------------
-- B15 bundledIntoId 悬空必须为 0（同捆自引用完整性；本地 51 子单）
-- ---------------------------------------------------------------------------
SELECT 'B15 bundle orphan' AS assertion, c.id AS child_sid, c.bundled_into_id
FROM send_orders c
LEFT JOIN send_orders p ON p.id = c.bundled_into_id
WHERE c.bundled_into_id IS NOT NULL AND p.id IS NULL;

-- ---------------------------------------------------------------------------
-- B16 totalfee 脏数据禁回填断言：charged_total_fee 必须全 NULL（§4.3）
-- ---------------------------------------------------------------------------
SELECT 'B16 charged_total_fee null' AS assertion, COUNT(*) AS non_null_cnt
FROM send_orders WHERE charged_total_fee IS NOT NULL;

-- ---------------------------------------------------------------------------
-- B17 legacyExtra 留档：countweight 脏值行（非数值非空）必须全部留档
-- ---------------------------------------------------------------------------
SELECT 'B17 legacyExtra countweight' AS assertion,
  (SELECT COUNT(*) FROM send_orders WHERE legacy_extra IS NOT NULL) AS now_cnt,
  (SELECT COUNT(*) FROM dg_sendorder s JOIN member m ON m.id = s.uid
     WHERE s.countweight IS NOT NULL AND s.countweight <> '' AND s.countweight <> '0'
       AND s.countweight NOT REGEXP '^[0-9]+(\.[0-9]+)?$') AS expected;

-- ---------------------------------------------------------------------------
-- B18 mailremark 双形态拆分：JSON 形态行必须两列都有值（§4.9）
-- ---------------------------------------------------------------------------
SELECT 'B18 mailremark split' AS assertion,
  (SELECT COUNT(*) FROM send_orders WHERE mail_attachments IS NOT NULL) AS with_files,
  (SELECT COUNT(*) FROM send_orders WHERE mail_remark IS NOT NULL) AS with_text;
