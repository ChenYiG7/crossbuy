-- ============================================================================
-- T1 回填（核心三件套）：order_groups / orders / order_status_histories
--
-- 上游决策：
--   · Q5 已拍板（2026-10-14）：OrderGroup 显式化，bargainAmount 挂组级，
--     carrier/holder 整套机制删除。见 docs/plans/05-order-group-评审与拍板.md
--   · 回填口径：**同 tid 全部行 SUM(bargainprice)** 挂组（口径无关，两种历史
--     holder 规则天然兼容；186 个多行持值异常组随 SUM 天然处理，不订正）
--
-- 纪律（沿用 member 域）：
--   ① 只写**新表**，绝不写旧表（dg_order 等只读）。
--   ② 幂等：INSERT ... SELECT ... ON DUPLICATE KEY UPDATE，可反复跑。
--   ③ 显式带 id：orders.id == dg_order.oid（oid 有空洞，顶自增用 MAX(id)+1）。
--   ④ **JOIN member 过滤外键孤儿**（member 回填铁律）：dg_order 328,479 行中
--      256,167 行 uid 不在本地 dg_users 副本 → 回填约 72,312 行（实测量级）。
--   ⑤ INT unix → DATETIME 一律 SQL FROM_UNIXTIME（禁 PHP date 直转，+08:00 坑）。
--   ⑥ float → Decimal 无损（旧值两位小数）；禁 PHP 侧运算。
--
-- ⚠ 本地演练前置：先跑 0006-order-source-import.sql（旧表落地 dryrun）+
--   0002-member-backfill-t1.sql（member 回填）。
--   生产 T1：源表同库，去掉脚本中一切库前缀即可（本脚本已用裸表名）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 有效订单集合（uid 在 member 中存在的订单）——组表与 orders 的共同基线
--    只取建组需要的 7 列。
--    ⚠ 用**正式暂存表**而非 TEMPORARY：MySQL 临时表在同一语句中被多次引用会报
--      ERROR 1137 (Can't reopen table)——本脚本组表 INSERT 需引用它 3 次。
--      脚本头尾 DROP，中途失败会残留一张 _t1_valid_order（无害，重跑即重置）。
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _t1_valid_order;
CREATE TABLE _t1_valid_order (
  oid INT PRIMARY KEY,
  uid INT NOT NULL,
  -- ⚠ collation 必须与 order_groups.tid 一致（utf8mb4_general_ci，0002a）——
--   否则 JOIN 时报 ERROR 1267 Illegal mix of collations（0002a 注释预告的坑）
  tid VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  bargainprice FLOAT NOT NULL,
  sendprice FLOAT NOT NULL,
  addtime INT,
  supplier_shop_id INT UNSIGNED NOT NULL,
  KEY idx_tid (tid)
) ENGINE=InnoDB;

INSERT INTO _t1_valid_order (oid, uid, tid, bargainprice, sendprice, addtime, supplier_shop_id)
SELECT o.oid, o.uid, o.tid, o.bargainprice, o.sendprice, o.addtime, o.supplier_shop_id
FROM dg_order o
JOIN member m ON m.id = o.uid;

-- ⚠ 必须 ANALYZE：新建+插满的暂存表持久统计信息为空，相关子查询会选错计划
--   （本地实测：不 ANALYZE 时组表 INSERT 290s+ 未完成；ANALYZE 后 2.2s）
ANALYZE TABLE _t1_valid_order;

-- ---------------------------------------------------------------------------
-- 1. order_groups：按 tid 建组（非空 tid）
--    · member_id / supplier_shop_id 取组内 **最大 oid 行**（旧 holder 规则现口径，
--      语义 = 组的代表行；组内 uid 理论上唯一，本地实测 121,937 组中仅 2 组跨会员）
--    · bargain_amount = SUM(bargainprice)（Q5 拍板口径，与 holder 在哪行无关）
--    · created_at = 组内 MIN(addtime)
-- ---------------------------------------------------------------------------
INSERT INTO order_groups (
  tid, member_id, supplier_shop_id,
  bargain_amount, shipping_fee_total, created_at
)
SELECT
  v.tid,
  (SELECT h.uid FROM _t1_valid_order h WHERE h.tid = v.tid ORDER BY h.oid DESC LIMIT 1),
  (SELECT h.supplier_shop_id FROM _t1_valid_order h WHERE h.tid = v.tid ORDER BY h.oid DESC LIMIT 1),
  SUM(v.bargainprice),
  SUM(v.sendprice),
  FROM_UNIXTIME(MIN(v.addtime))
FROM _t1_valid_order v
WHERE v.tid <> ''
GROUP BY v.tid
ON DUPLICATE KEY UPDATE
  member_id = VALUES(member_id),
  supplier_shop_id = VALUES(supplier_shop_id),
  bargain_amount = VALUES(bargain_amount),
  shipping_fee_total = VALUES(shipping_fee_total),
  created_at = VALUES(created_at);

-- ---------------------------------------------------------------------------
-- 2. order_groups：空 tid 单独立成组
--    · legacy_order_id = oid（UNIQUE 幂等键——tid 为 NULL 时 UNIQUE 不去重 NULL）
--    · 本地实测空 tid 单 11,988 行（其中有效会员的进本步），94% 为无效态，
--      仅 31 行带砍价 → 代价可忽略（05 文档 §4.3）
-- ---------------------------------------------------------------------------
INSERT INTO order_groups (
  tid, legacy_order_id, member_id, supplier_shop_id,
  bargain_amount, shipping_fee_total, created_at
)
SELECT
  NULL,
  v.oid,
  v.uid,
  NULLIF(v.supplier_shop_id, 0),
  v.bargainprice,
  v.sendprice,
  FROM_UNIXTIME(NULLIF(v.addtime, 0))
FROM _t1_valid_order v
WHERE v.tid = ''
ON DUPLICATE KEY UPDATE
  member_id = VALUES(member_id),
  supplier_shop_id = VALUES(supplier_shop_id),
  bargain_amount = VALUES(bargain_amount),
  shipping_fee_total = VALUES(shipping_fee_total),
  created_at = VALUES(created_at);

-- ---------------------------------------------------------------------------
-- 2.5 组映射表：oid → group_id（每单一行；两个分支各走 UNIQUE 索引）
--     · tid 组：g.tid = v.tid（order_groups_tid_key）
--     · 独立组：g.legacy_order_id = v.oid（order_groups_legacy_order_id_key）
--     建一次全局复用，禁在主 INSERT 里写 OR 关联（见 §3 注释的性能坑）
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _t1_order_group;
CREATE TABLE _t1_order_group (
  oid INT PRIMARY KEY,
  group_id INT NOT NULL,
  KEY idx_group (group_id)
) ENGINE=InnoDB;

INSERT INTO _t1_order_group (oid, group_id)
SELECT v.oid, g.id
FROM _t1_valid_order v
JOIN order_groups g ON g.tid = v.tid
WHERE v.tid <> ''
UNION ALL
SELECT v.oid, g.id
FROM _t1_valid_order v
JOIN order_groups g ON g.legacy_order_id = v.oid
WHERE v.tid = '';

ANALYZE TABLE _t1_order_group;

-- ---------------------------------------------------------------------------
-- 3. orders：oid 对齐分片回填（存储过程）
--
-- 分片策略（生产 587 万行同逻辑放大）：
--   每批先从 dg_order 按 oid 顺序取 batch_size 个 oid 进 _slice（临时表），
--   再 JOIN member/组映射做主体 INSERT——避免 LIMIT+ORDER BY 在大表上反复全扫；
--   批间用 _slice.MAX(oid) 推进水位。
--   ⚠ oid 有大量空洞（本地 AUTO_INCREMENT 5,371,631 / 实 328,479），
--     禁按 oid 区间等分，必须 ORDER BY oid LIMIT 逐批推进。
--   ⚠ 组关联禁写 `g.tid=o.tid OR g.legacy_order_id=o.oid`——两列 OR 条件走不了
--     索引，72K 订单 × 13 万组会退化成全表嵌套扫描（本地实测 10 分钟跑不完）。
--     正确做法：预建 _t1_order_group 映射表（两个分支各走 UNIQUE 索引 UNION），
--     主查询只做 PK JOIN。
--
-- 字段转换要点：
--   · status_entered_at：12 态 → 旧时间列映射（way=3/ruku=4/peisong=5/wuxiao=6,10,11/
--     incre=7/custo=9/custowait=12/pay=2/addtime=1；arrivetime 只服务 8 态兜底）
--   · sid：'0'/''/NULL → NULL；仅纯数字串 CAST（防脏值变 0）
--   · expressno：_S 后缀 → is_after_sale；_N 后缀 → reissue_seq（REGEXP_SUBSTR）
--   · mark_flag：2bit 一态打包 → isFavorite = (mf & 3)=1；arrivalMark = (mf>>2)&3
--   · inspection_options：var1-12 + yanhuo 家族 + 平台标签 30+ 列 → JSON
--     （JSON_OBJECT 对 NULL 值输出 JSON null——契约规定 null/'' = 未勾选；
--      新系统写入时为稀疏对象，两层形态契约都兼容）
--   · service_fee_offset：从 extend JSON 解析 deducted_service_fee（Q9 显式化第一步）
--   · charged_amount：0.00（payOrder 快照无回填源；正本在 finance.ledger_entry）
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS _backfill_orders;
DELIMITER $$
CREATE PROCEDURE _backfill_orders(IN batch_size INT)
BEGIN
  DECLARE last_oid INT DEFAULT 0;
  DECLARE sliced INT DEFAULT 1;

  DROP TEMPORARY TABLE IF EXISTS _slice;
  CREATE TEMPORARY TABLE _slice (oid INT PRIMARY KEY);

  WHILE sliced > 0 DO
    DELETE FROM _slice;
    INSERT INTO _slice (oid)
      SELECT o.oid FROM dg_order o
      JOIN member m ON m.id = o.uid
      WHERE o.oid > last_oid
      ORDER BY o.oid
      LIMIT batch_size;
    SET sliced = ROW_COUNT();

    IF sliced > 0 THEN
      INSERT INTO orders (
        id, group_id, member_id, type, status, status_entered_at,
        source, creation_mode, source_ref, out_id, belong_company, pay_id, xz_assignee,
        goods_id, goods_url, goods_name, goods_img, order_img, sku_name,
        goods_size, goods_color, goods_seller, goods_site,
        supplier_shop_id, supplier_product_id, df_goods_name,
        quantity, unit_price, bargained_unit_price, promo_price, shipping_fee,
        purchase_unit_price, purchase_shipping_fee, inspection_fee,
        charged_amount, charged_currency, service_fee_offset,
        send_order_id, domestic_tracking_no, reissue_no, reissue_seq, is_after_sale,
        weight_grams, ship_method, is_sensitive,
        df_store_mode, terms, is_urgent, is_favorite, arrival_mark,
        inspection_options, asin, fnsku,
        buyer_remark, admin_remark, remarks_extra, extend_extra, auto_order_error,
        legacy_state_times, created_at, updated_at, deleted_at
      )
      SELECT
        o.oid,
        og.group_id,
        o.uid,
        o.type,
        o.state,
        CASE o.state
          WHEN 1 THEN FROM_UNIXTIME(NULLIF(o.addtime, 0))
          WHEN 2 THEN FROM_UNIXTIME(NULLIF(o.paytime, 0))
          WHEN 3 THEN FROM_UNIXTIME(NULLIF(o.waytime, 0))
          WHEN 4 THEN FROM_UNIXTIME(NULLIF(o.rukutime, 0))
          WHEN 5 THEN FROM_UNIXTIME(NULLIF(o.peisongtime, 0))
          WHEN 6 THEN FROM_UNIXTIME(NULLIF(o.wuxiaotime, 0))
          WHEN 7 THEN FROM_UNIXTIME(NULLIF(o.incretime, 0))
          WHEN 8 THEN FROM_UNIXTIME(NULLIF(o.arrivetime, 0))
          WHEN 9 THEN FROM_UNIXTIME(NULLIF(o.custotime, 0))
          WHEN 10 THEN FROM_UNIXTIME(NULLIF(o.wuxiaotime, 0))
          WHEN 11 THEN FROM_UNIXTIME(NULLIF(o.wuxiaotime, 0))
          WHEN 12 THEN FROM_UNIXTIME(NULLIF(o.custowaittime, 0))
          ELSE FROM_UNIXTIME(NULLIF(o.addtime, 0))
        END,
        CASE o.add_from WHEN 2 THEN 'plugin' WHEN 8 THEN 'api' ELSE 'web' END,
        CASE o.purchase_type WHEN 1 THEN 'manual' WHEN 2 THEN 'auto' ELSE 'one_click' END,
        NULLIF(o.add_from_memo, ''),
        o.outid,
        o.belong_company,
        NULLIF(o.payid, ''),
        NULLIF(o.xz, '0'),
        o.goodsid,
        o.goodsurl,
        o.goodsname,
        o.goodsimg,
        o.orderimg,
        o.sku_name,
        o.goodssize,
        o.goodscolor,
        o.goodsseller,
        o.goodssite,
        NULLIF(o.supplier_shop_id, 0),
        NULLIF(o.supplier_product_id, 0),
        o.dfgoodsname,
        COALESCE(o.goodsnum, 1),
        o.goodsprice,
        o.goodsprice1,
        o.proprice,
        o.sendprice,
        o.goodsuprice,
        o.senduprice,
        o.inspection,
        0.00,
        'JPY',
        COALESCE(
          CASE WHEN JSON_VALID(o.extend)
            THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(CAST(o.extend AS JSON), '$.deducted_service_fee')) AS DECIMAL(12, 2))
          END, 0.00),
        CASE WHEN o.sid REGEXP '^[0-9]+$' THEN CAST(o.sid AS SIGNED) END,
        o.expressno,
        o.bufaid,
        -- 补发序号：尾段 _N（MySQL REGEXP_SUBSTR 无捕获组参数，用 SUBSTRING_INDEX 替代）
        CASE WHEN o.expressno REGEXP '_[0-9]+$'
          THEN CAST(SUBSTRING_INDEX(o.expressno, '_', -1) AS SIGNED) END,
        RIGHT(o.expressno, 2) = '_S',
        o.orderweight,
        o.ship,
        o.flag = 2,
        o.dfstoremode = 1,
        JSON_OBJECT(
          'qtyShortBuy', o.TermQty = 'Y',
          'priceAdjust', o.TermPrice = 'Y',
          'shippingAdjust', o.TermShipping = 'Y'
        ),
        o.isjinji = '1',
        (COALESCE(o.mark_flag, 0) & 3) = 1,
        (COALESCE(o.mark_flag, 0) >> 2) & 3,
        JSON_OBJECT(
          'var1', NULLIF(o.var1, ''), 'var2', NULLIF(o.var2, ''), 'var3', NULLIF(o.var3, ''),
          'var4', NULLIF(o.var4, ''), 'var5', NULLIF(o.var5, ''), 'var6', NULLIF(o.var6, ''),
          'var7', NULLIF(o.var7, ''), 'var8', NULLIF(o.var8, ''), 'var9', NULLIF(o.var9, ''),
          'var10', NULLIF(o.var10, ''), 'var11', NULLIF(o.var11, ''), 'var12', NULLIF(o.var12, ''),
          'yanhuofba', NULLIF(o.yanhuofba, ''), 'yanhuojinyun', NULLIF(o.yanhuojinyun, ''),
          'yanhuozengzhi', NULLIF(o.yanhuozengzhi, ''), 'yanhuoasin', NULLIF(o.yanhuoasin, ''),
          'yanhuofnsku', NULLIF(o.yanhuofnsku, ''),
          'baozhuang', NULLIF(o.baozhuang, ''), 'hbbaozhuang', NULLIF(o.hbbaozhuang, ''),
          'baonum', NULLIF(o.baonum, ''),
          'SKU', NULLIF(o.SKU, ''), 'shangpin_sku', NULLIF(o.shangpin_sku, ''),
          'FNSKU', NULLIF(o.FNSKU, ''), 'shangpin_fnsku', NULLIF(o.shangpin_fnsku, ''),
          'name', NULLIF(o.name, ''), 'shangpin_name', NULLIF(o.shangpin_name, ''),
          'amazon', NULLIF(o.amazon, ''), 'shangpin_amazon', NULLIF(o.shangpin_amazon, ''),
          'putong', NULLIF(o.putong, ''), 'fuzhuang', NULLIF(o.fuzhuang, ''),
          'tiebiao', NULLIF(o.tiebiao, ''), 'huanbaoz', NULLIF(o.huanbaoz, ''),
          'qita', NULLIF(o.qita, '')
        ),
        NULLIF(o.yanhuoasin, ''),
        NULLIF(o.yanhuofnsku, ''),
        NULL,
        o.mremark,
        JSON_OBJECT(
          'goodsremark', o.goodsremark, 'goodsremark1', o.goodsremark1,
          'goodsremark2', o.goodsremark2, 'goodsremark3', o.goodsremark3,
          'goodsremark4', o.goodsremark4, 'orderremark', o.orderremark
        ),
        CASE WHEN JSON_VALID(o.extend) THEN CAST(o.extend AS JSON) END,
        o.auto_order_error,
        JSON_OBJECT(
          'addtime', FROM_UNIXTIME(NULLIF(o.addtime, 0)),
          'paytime', FROM_UNIXTIME(NULLIF(o.paytime, 0)),
          'conttime', FROM_UNIXTIME(NULLIF(o.conttime, 0)),
          'waytime', FROM_UNIXTIME(NULLIF(o.waytime, 0)),
          'incretime', FROM_UNIXTIME(NULLIF(o.incretime, 0)),
          'custowaittime', FROM_UNIXTIME(NULLIF(o.custowaittime, 0)),
          'custotime', FROM_UNIXTIME(NULLIF(o.custotime, 0)),
          'rukutime', FROM_UNIXTIME(NULLIF(o.rukutime, 0)),
          'peisongtime', FROM_UNIXTIME(NULLIF(o.peisongtime, 0)),
          'wuxiaotime', FROM_UNIXTIME(NULLIF(o.wuxiaotime, 0)),
          'print_examination_time', FROM_UNIXTIME(NULLIF(o.print_examination_time, 0)),
          'arrivetime', FROM_UNIXTIME(NULLIF(o.arrivetime, 0))
        ),
        COALESCE(FROM_UNIXTIME(NULLIF(o.addtime, 0)), '1970-01-01 00:00:01'),
        COALESCE(FROM_UNIXTIME(NULLIF(o.uptime, 0)), FROM_UNIXTIME(NULLIF(o.addtime, 0)), '1970-01-01 00:00:01'),
        o.deleted_at
      FROM dg_order o
      JOIN _slice s ON s.oid = o.oid
      JOIN member m ON m.id = o.uid
      JOIN _t1_order_group og ON og.oid = o.oid
      ON DUPLICATE KEY UPDATE
        group_id = VALUES(group_id),
        member_id = VALUES(member_id),
        type = VALUES(type),
        status = VALUES(status),
        status_entered_at = VALUES(status_entered_at),
        source = VALUES(source),
        creation_mode = VALUES(creation_mode),
        source_ref = VALUES(source_ref),
        out_id = VALUES(out_id),
        belong_company = VALUES(belong_company),
        pay_id = VALUES(pay_id),
        xz_assignee = VALUES(xz_assignee),
        goods_id = VALUES(goods_id),
        goods_url = VALUES(goods_url),
        goods_name = VALUES(goods_name),
        goods_img = VALUES(goods_img),
        order_img = VALUES(order_img),
        sku_name = VALUES(sku_name),
        goods_size = VALUES(goods_size),
        goods_color = VALUES(goods_color),
        goods_seller = VALUES(goods_seller),
        goods_site = VALUES(goods_site),
        supplier_shop_id = VALUES(supplier_shop_id),
        supplier_product_id = VALUES(supplier_product_id),
        df_goods_name = VALUES(df_goods_name),
        quantity = VALUES(quantity),
        unit_price = VALUES(unit_price),
        bargained_unit_price = VALUES(bargained_unit_price),
        promo_price = VALUES(promo_price),
        shipping_fee = VALUES(shipping_fee),
        purchase_unit_price = VALUES(purchase_unit_price),
        purchase_shipping_fee = VALUES(purchase_shipping_fee),
        inspection_fee = VALUES(inspection_fee),
        service_fee_offset = VALUES(service_fee_offset),
        send_order_id = VALUES(send_order_id),
        domestic_tracking_no = VALUES(domestic_tracking_no),
        reissue_no = VALUES(reissue_no),
        reissue_seq = VALUES(reissue_seq),
        is_after_sale = VALUES(is_after_sale),
        weight_grams = VALUES(weight_grams),
        ship_method = VALUES(ship_method),
        is_sensitive = VALUES(is_sensitive),
        df_store_mode = VALUES(df_store_mode),
        terms = VALUES(terms),
        is_urgent = VALUES(is_urgent),
        is_favorite = VALUES(is_favorite),
        arrival_mark = VALUES(arrival_mark),
        inspection_options = VALUES(inspection_options),
        asin = VALUES(asin),
        fnsku = VALUES(fnsku),
        admin_remark = VALUES(admin_remark),
        remarks_extra = VALUES(remarks_extra),
        extend_extra = VALUES(extend_extra),
        auto_order_error = VALUES(auto_order_error),
        legacy_state_times = VALUES(legacy_state_times),
        created_at = VALUES(created_at),
        updated_at = VALUES(updated_at),
        deleted_at = VALUES(deleted_at);

      SET last_oid = (SELECT MAX(oid) FROM _slice);
    END IF;
  END WHILE;

  DROP TEMPORARY TABLE IF EXISTS _slice;
END$$
DELIMITER ;

-- 本地 328,479 行（有效 72,312）：批 20,000 跑 4 批；
-- 生产 587 万行建议批 50,000（约 118 批），每批短连接外单独提交（防隧道断连）
CALL _backfill_orders(20000);
DROP PROCEDURE IF EXISTS _backfill_orders;

-- ---------------------------------------------------------------------------
-- 4. order_status_histories：合成建单事件（旧系统无迁移表，只补初始态一行；
--    历史逐态迁移已无法从平铺时间列可靠还原——原值全量保在
--    orders.legacy_state_times，审计按 oid 反查）
--
--    ⚠ 幂等守卫用 NOT EXISTS 而非 ODKU：本表无唯一键（历史表语义——真实迁移
--       会重复 toStatus，禁建 unique），而 from_status=NULL 在唯一索引里不去重。
--       2026-10-15 修正：旧版 ODKU 写法在重跑时翻倍插入（dryrun 实测 73,291→146,582）。
-- ---------------------------------------------------------------------------
INSERT INTO order_status_histories (order_id, from_status, to_status, operator_type, operator_id, reason, created_at)
SELECT o.id, NULL, o.status, 'system', NULL, 'T1 backfill', o.created_at
FROM orders o
WHERE NOT EXISTS (
  SELECT 1 FROM order_status_histories h
  WHERE h.order_id = o.id AND h.reason = 'T1 backfill'
);

-- ---------------------------------------------------------------------------
-- 5. 顶 AUTO_INCREMENT（保留旧 id 的表；用 MAX(id)+1，禁行数——oid 有空洞）
-- ---------------------------------------------------------------------------
SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM orders);
SET @sql := CONCAT('ALTER TABLE orders AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_groups);
SET @sql := CONCAT('ALTER TABLE order_groups AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ai := (SELECT COALESCE(MAX(id), 0) + 1 FROM order_status_histories);
SET @sql := CONCAT('ALTER TABLE order_status_histories AUTO_INCREMENT = ', @ai);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 6. 完事快照
-- ---------------------------------------------------------------------------
SELECT 'order_groups' AS tbl, COUNT(*) AS rows_now FROM order_groups
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_status_histories', COUNT(*) FROM order_status_histories
UNION ALL SELECT '_t1_valid_order(基线)', COUNT(*) FROM _t1_valid_order;

-- 7. 清理暂存表（保留会占用空间；失败重跑时头部 DROP 会重建）
DROP TABLE IF EXISTS _t1_valid_order;
DROP TABLE IF EXISTS _t1_order_group;
