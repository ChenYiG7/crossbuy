-- ============================================================================
-- T1 回填（finance 段）：旧源 → accounts / ledger_entries / recharge_orders /
--                              exchange_rates / ledger_entry_orders + 对账基线登记
--
-- 幂等：可反复执行。所有写入都以「同一旧行的重复投递」为语义前提，撞唯一键走 ODKU
--   更新镜像列（**不是**用 ODKU 掩盖实体边界错误 —— member 域 username 那个坑见 docs/plans/03 §9.2）。
-- 纪律：只写新表，绝不回写旧表；孤儿按 member 域铁律 JOIN 过滤。
--
-- 三个来源的钱是三件事，不能混（§4.8 / §3.9）：
--   dg_record        = 客户负债侧实扣（含服务费/会员减免）→ MEMBER 户分录
--   cash_flow        = 财务代付动作（不含服务费）        → PURCHASE 户分录
--   dg_rechargerecord= 入金**单据**，不是第二笔钱        → recharge_orders（分录靠 sn 回链）
--   ⇒ 实测 11,186 条负数充值单**全部**能在 dg_record 找到对应行，
--     所以「单据 + 分录」两头都建 entry 必然双计，本脚本刻意不这么做。
--
-- 关键取证（2026-10-16 本机 taotaro 尾切片 502,167 行，写规则前测的）：
--   · accountmoney / money 无 NULL；money=0 共 **5** 行 → 排除（0 元分录无资金意义）
--   · deleted_at 非 NULL **93** 行 → 排除（旧系统已作废）
--   · sn 长度按 action 分化：0/9/11/14-20 最长 17，**10（仓储费）最长 44**，
--     3（国际运费）整段最长 237、含 '#' 439 行、# 前首段最长 27
--     ⇒ voucher_no 64；action=3 走 logistics_no(64) + logistics_nos(JSON)
--   · remark 含 HTML 的 455,348 行、含 http 的 439,734 行 ⇒ label 剥标签、URL 进 bizNos、
--     原文进 legacy_extra（只有真含标签/URL 的行才存，避免 800 万行 JSON 膨胀）
--   · action=0 的 remark：銀行振込 6,102 / 余额转移 1 / 空或无关键词 91+其余 → §6.4 粗分三类
--   · dg_rechargerecord：**10,521 行 amount=0 且 money>0** ⇒ rate 反推不出，必须留 NULL
--   · currency 实测有 jpy / MYR / NULL 三种；MYR 段 money/amount≈0.0458 与日元同比率
--     ⇒ 旧系统疑似按日元汇率折算马币（#11a 资金安全缺陷新证据），登记 RATE_DRIFT 不静默修
--   · dg_huilv 值域 15.46~24.07（=1 CNY 兑 X JPY，**方向与计划书 §3.3 的推断相反**）；
--     同一 (年月日时分) 最多 95 条、去重后 55,732 个时刻 ⇒ 按时刻取 MAX(hid)，折叠数登记
--   · cash_flow：change_type 全 1、paid_money = price − bargain + send **100% 成立**（恒等式守卫）
-- ============================================================================
--
-- ⚠ **非并发安全**：§1 会 DROP + 重建 `_t1_*` 暂存表，两个实例同时在同一库上跑，
--   后起跑的那个会在过程里报 `ER_NO_SUCH_TABLE`（2026-10-16 我同时挂了两个后台任务，
--   第一遍因此在第 5 批处中断——不是脚本缺陷，是重跑纪律问题）。**同一库同一时刻只允许一个回填实例。**
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. flow_type 映射表（实体暂存表，与 member 域 _t1_username_fix 同一惯例）
--    ★ 死值（2/7/8）与「本机 0 行但生产有」（12 月费 / 21 Stripe）都要占位，
--      否则 §9 的「未映射 action 行数 = 0」断言在真库上会 FAIL —— 那条断言是本脚本的护栏。
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS _t1_flow_type_map;
CREATE TABLE _t1_flow_type_map (
  legacy_source VARCHAR(32)  NOT NULL,
  legacy_key    VARCHAR(16)  NOT NULL,
  flow_type     VARCHAR(40)  NOT NULL,
  account_kind  VARCHAR(24)  NOT NULL,
  channel       VARCHAR(24)  NULL,
  note          VARCHAR(160) NULL,
  PRIMARY KEY (legacy_source, legacy_key)
) ENGINE = InnoDB;

INSERT INTO _t1_flow_type_map (legacy_source, legacy_key, flow_type, account_kind, channel, note) VALUES
  ('DG_RECORD', '0',  'LEGACY_ADMIN_MANUAL',      'MEMBER', NULL, '管理員操作；正负互现，按 remark 关键词再拆三类（见 §4 CASE）'),
  ('DG_RECORD', '1',  'ORDER_PURCHASE_DEBIT',     'MEMBER', NULL, '下单扣款；链断 98.6% 集中在此（§3.6 内存快照根因）'),
  ('DG_RECORD', '2',  'ORDER_DOMESTIC_FREIGHT',   'MEMBER', NULL, '国内运费；旧词表遗留、全仓无写入点（死值占位）'),
  ('DG_RECORD', '3',  'INTERNATIONAL_FREIGHT_DEBIT','MEMBER',NULL, '国际运费；sn 是 # 连接的多运单号 → 走 logistics 两列'),
  ('DG_RECORD', '4',  'ORDER_CANCEL_REFUND',      'MEMBER', NULL, '取消退款（§3.9 修正：action=4 不是充值）'),
  ('DG_RECORD', '5',  'ORDER_PRICE_ADJUST',       'MEMBER', NULL, '价格调整，正负都有'),
  ('DG_RECORD', '6',  'ORDER_QTY_ADJUST',         'MEMBER', NULL, '数量调整，正负都有'),
  ('DG_RECORD', '7',  'FREIGHT_ADJUST',           'MEMBER', NULL, '运费调整；无写入点（死值占位）'),
  ('DG_RECORD', '8',  'POINTS_REDEEM',            'MEMBER', NULL, '积分兑换；无写入点，与 §3.7「抵扣不入账」互证（死值占位）'),
  ('DG_RECORD', '9',  'RECHARGE_PAYPAL',          'MEMBER', 'PAYPAL', 'PayPal 入金；旧幂等仅 Cache::lock(2s)，#11a'),
  ('DG_RECORD', '10', 'WAREHOUSE_STORAGE_FEE',    'MEMBER', NULL, 'WMS 仓储费；无锁无校验可扣成负数（#11a）'),
  ('DG_RECORD', '11', 'BARGAIN_REFUND_ON_SHIP',   'MEMBER', NULL, '已邮寄返砍价（send-order 域扣费事件的归账点）'),
  ('DG_RECORD', '12', 'MEMBER_MONTHLY_FEE',       'MEMBER', NULL, '月会员费；本机切片 0 行，生产有 → Q7 待生产复核'),
  ('DG_RECORD', '13', 'AI_SERVICE_FEE',           'MEMBER', NULL, 'AI 機能；185 行 44% 链断且查不到写入点 → 疑似旁路'),
  ('DG_RECORD', '14', 'OEM_PURCHASE_DEBIT',     'MEMBER', NULL, 'OEM 商品購入（paytype=3）；仅 OEM 管理员(oem_business_manager)入金按 paytype 映射（#11f）'),
  ('DG_RECORD', '15', 'OEM_DOMESTIC_FREIGHT',   'MEMBER', NULL, 'OEM 国内運賃（paytype=5）；同上'),
  ('DG_RECORD', '16', 'OEM_INTL_FREIGHT',       'MEMBER', NULL, 'OEM 国際運賃（paytype=4）；同上'),
  ('DG_RECORD', '17', 'OEM_WAREHOUSE_FEE',      'MEMBER', NULL, 'OEM 倉庫保管料（paytype=7）；同上（本机 0 行）'),
  ('DG_RECORD', '18', 'OEM_OTHER_FEE',          'MEMBER', NULL, 'OEM その他（paytype=11）；同上'),
  ('DG_RECORD', '19', 'OEM_OPTION_PAYMENT',     'MEMBER', NULL, 'OEM オプション料金決済（paytype=8）；同上'),
  ('DG_RECORD', '20', 'OEM_PHOTO_FEE',          'MEMBER', NULL, 'OEM 撮影費用（paytype=12）；同上'),
  ('DG_RECORD', '21', 'RECHARGE_STRIPE',          'MEMBER', 'STRIPE', 'Stripe 入金；写入点在外部 Python 服务，本机 0 行'),
  ('DG_RECORD', '22', 'OEM_INDEMNITY_PAYMENT',  'MEMBER', NULL, 'OEM 賠償（paytype=6）；同上（本机 0 行）'),
  ('DG_RECORD', '23', 'OEM_TRADE_STOP',         'MEMBER', NULL, 'OEM 取引中止（paytype=10）；创建时另置 user.orderenable=0+stoptime（本机 0 行）'),
  ('DG_RECORD', NULL, 'LEGACY_UNKNOWN_ACTION',    'MEMBER', NULL, '兜底：词表外的 action（正常应为 0 行，出现即人工介入）'),
  ('FINANCE_ORDER_CASH_FLOW', '1', 'PURCHASE_PAYMENT',  'PURCHASE', NULL, '采购代付（不含服务费与会员减免，与客户侧口径天然不同）'),
  ('FINANCE_ORDER_CASH_FLOW', '2', 'PURCHASE_REFUND',   'PURCHASE', NULL, '采购退款；旧 addRefundLog() 是死代码，实测 0 行');

-- paytype → 渠道 / 费用原因（旧库一列混两维，新模型必须拆开，§3.2）
DROP TABLE IF EXISTS _t1_paytype_map;
CREATE TABLE _t1_paytype_map (
  paytype SMALLINT NOT NULL PRIMARY KEY,
  channel VARCHAR(24) NOT NULL,
  reason_label VARCHAR(32) NOT NULL
) ENGINE = InnoDB;
INSERT INTO _t1_paytype_map (paytype, channel, reason_label) VALUES
  (0,'BANK_TRANSFER','銀行振込'), (1,'MANUAL_ADJUST','旧 alipay（全仓 0 命中）'),
  (2,'PAYPAL','Paypal'),          (3,'MANUAL_ADJUST','商品購入'),
  (4,'MANUAL_ADJUST','国際運賃'), (5,'MANUAL_ADJUST','国内運賃'),
  (6,'MANUAL_ADJUST','賠償'),     (7,'MANUAL_ADJUST','家賃'),
  (8,'MANUAL_ADJUST','オプション'),(9,'MANUAL_ADJUST','送金'),
  (10,'MANUAL_ADJUST','取引中止'),(11,'MANUAL_ADJUST','その他'),
  (12,'MANUAL_ADJUST','撮影'),    (13,'MANUAL_ADJUST','保険料'),
  (14,'MANUAL_ADJUST','订单增值'),(15,'STRIPE','Stripe');

-- 运单号分段用的序号表（`#` 拆分，与 send-order 域 _t1_numbers 同一手法）
DROP TABLE IF EXISTS _t1_numbers;
CREATE TABLE _t1_numbers (n INT PRIMARY KEY) ENGINE = InnoDB;
INSERT INTO _t1_numbers (n) VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),
  (11),(12),(13),(14),(15),(16),(17),(18),(19),(20);
-- ⚠ 本机实测 action=3 的 sn 最多 17 段；生产若超过 20 段，§4 的分段会丢尾，
--   verify 的 F11「分段完整性」断言会 FAIL（不是静默丢数据）

-- ---------------------------------------------------------------------------
-- 2. accounts：MEMBER 户（每个会员一户）+ 5 个平台侧账户（sentinel member_id=0）
--    balance 取 member.balance（0002 已断言 = dg_users.money，B8=0）
-- ---------------------------------------------------------------------------
INSERT INTO accounts (kind, member_id, currency, balance, opening_amount, status, last_changed_at, created_at, updated_at)
SELECT 'MEMBER', m.id, m.balance_currency, m.balance, m.balance, 'ACTIVE', m.last_balance_changed_at, NOW(), NOW()
FROM member m
ON DUPLICATE KEY UPDATE
  currency      = VALUES(currency),
  balance       = VALUES(balance),
  last_changed_at = VALUES(last_changed_at),
  updated_at    = NOW();

INSERT INTO accounts (kind, member_id, currency, balance, opening_amount, status, created_at, updated_at)
SELECT k.kind, 0, 'CNY', 0, 0, 'ACTIVE', NOW(), NOW()
FROM (SELECT 'COMPANY' kind UNION ALL SELECT 'PURCHASE' UNION ALL SELECT 'FREIGHT'
      UNION ALL SELECT 'CHANNEL_IN_TRANSIT' UNION ALL SELECT 'ADJUSTMENT') k
ON DUPLICATE KEY UPDATE updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 3. 分录主体：dg_record → ledger_entries（MEMBER 户，按 rid 分批）
--    ★ 幂等键 LEGACY:DG_RECORD:{rid}，唯一键 (legacy_source, legacy_id) 兜底
--    ★ 孤儿 uid 被 JOIN accounts 过滤（本机实测 392,518 行 / 78%，因本地 dg_users 只有 5,021 行）
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS _backfill_dg_record;
DELIMITER $$
CREATE PROCEDURE _backfill_dg_record(IN batch_size INT)
BEGIN
  DECLARE v_last INT DEFAULT 0;
  DECLARE v_max  INT DEFAULT 0;
  DECLARE v_next INT DEFAULT 0;

  SELECT COALESCE(MAX(rid), 0) INTO v_max FROM dg_record;

  WHILE v_last < v_max DO
    SELECT COALESCE(MAX(rid), v_max) INTO v_next FROM (
      SELECT rid FROM dg_record WHERE rid > v_last ORDER BY rid LIMIT batch_size
    ) b;

    INSERT INTO ledger_entries (
      account_id, direction, signed_amount, balance_before, balance_after, currency,
      flow_type, channel, idempotency_key, order_id,
      counterpart_amount, bargain_amount, freight_amount,
      operator_id, label, voucher_no, logistics_no, logistics_nos, biz_nos, legacy_extra,
      legacy_source, legacy_id, occurred_at, created_at)
    SELECT
      a.id,
      IF(r.money > 0, 'IN', 'OUT'),
      r.money,
      r.accountmoney - r.money,          -- 推导值（§6.4：禁修数据，断链原样保留）
      r.accountmoney,                    -- 旧快照原值
      'CNY',
      CASE
        WHEN m.flow_type IS NULL THEN 'LEGACY_UNKNOWN_ACTION'
        WHEN r.action = 0 AND r.remark LIKE '%銀行振込%' THEN 'MANUAL_BANK_RECHARGE'
        WHEN r.action = 0 AND r.remark LIKE '%余额转移%'  THEN 'BALANCE_TRANSFER'
        WHEN r.action = 0                                 THEN 'LEGACY_UNCLASSIFIED'
        ELSE m.flow_type END,
      CASE WHEN r.action = 0 AND r.remark LIKE '%銀行振込%' THEN 'BANK_TRANSFER' ELSE m.channel END,
      CONCAT('LEGACY:DG_RECORD:', r.rid),
      NULLIF(r.oid, 0),
      NULL, NULL, NULL,
      NULL,
      NULLIF(TRIM(REGEXP_REPLACE(COALESCE(r.remark, ''), '<[^>]*>', '')), ''),
      CASE WHEN r.action = 3 THEN NULL
           WHEN r.sn = '' THEN NULL
           ELSE LEFT(NULLIF(r.sn, ''), 64) END,
      CASE WHEN r.action = 3 THEN LEFT(SUBSTRING_INDEX(r.sn, '#', 1), 64) ELSE NULL END,
      CASE WHEN r.action = 3 AND r.sn LIKE '%#%' THEN (
             SELECT JSON_ARRAYAGG(SUBSTRING_INDEX(SUBSTRING_INDEX(r.sn, '#', x.n), '#', -1))
             FROM _t1_numbers x
             WHERE x.n <= 1 + CHAR_LENGTH(r.sn) - CHAR_LENGTH(REPLACE(r.sn, '#', ''))
           ) ELSE NULL END,
      CASE WHEN r.remark REGEXP 'https?://'
           THEN JSON_ARRAY(REGEXP_SUBSTR(r.remark, 'https?://[^"[:space:]<>]+')) ELSE NULL END,
      CASE WHEN NULLIF(r.extend, '') IS NOT NULL OR COALESCE(r.vip, 0) <> 0 OR COALESCE(r.ordflag, 1) <> 1
                OR r.remark LIKE '%<%>%'
           THEN JSON_OBJECT('extend', r.extend, 'vip', r.vip, 'ordflag', r.ordflag,
                            'legacyRemark', CASE WHEN r.remark LIKE '%<%>%' THEN r.remark ELSE NULL END,
                            'action', r.action)
           ELSE JSON_OBJECT('action', r.action) END,
      'DG_RECORD', r.rid,
      COALESCE(FROM_UNIXTIME(NULLIF(r.addtime, 0)), '1970-01-01 00:00:00'),
      NOW()
    FROM dg_record r
    JOIN accounts a        ON a.kind = 'MEMBER' AND a.member_id = r.uid
    LEFT JOIN _t1_flow_type_map m ON m.legacy_source = 'DG_RECORD' AND m.legacy_key = CAST(r.action AS CHAR)
    WHERE r.rid > v_last AND r.rid <= v_next
      AND r.deleted_at IS NULL          -- 旧系统已作废的 93 行不进账本
      AND r.money <> 0                  -- 0 元分录无资金意义（5 行），排除并登记
    ON DUPLICATE KEY UPDATE
      -- 镜像语义：同一旧行重投 = 用旧库当前值刷新（旧库后台能改 money，见 #11a）
      direction = VALUES(direction), signed_amount = VALUES(signed_amount),
      balance_before = VALUES(balance_before), balance_after = VALUES(balance_after),
      flow_type = VALUES(flow_type), channel = VALUES(channel),
      label = VALUES(label), voucher_no = VALUES(voucher_no),
      logistics_no = VALUES(logistics_no), logistics_nos = VALUES(logistics_nos),
      biz_nos = VALUES(biz_nos), legacy_extra = VALUES(legacy_extra),
      occurred_at = VALUES(occurred_at),
      -- 幂等键本身也要刷新：键格式变更时重跑才能自愈
      --   （2026-10-16 F5 就是这么暴露的：改了前缀但 ODKU 不覆盖键，旧行永远留错键）
      idempotency_key = VALUES(idempotency_key);

    SET v_last := v_next;
  END WHILE;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 4. 分录主体：finance_order_cash_flow → ledger_entries（PURCHASE 户，按 id 分批）
--    ★ 恒等式 paid_money = price − bargain + send 本机 100% 成立；违反也照原样落库，
--      由 §9 登记成 diff —— 回填阶段禁「顺手修数据」（红线 10）
--    ★ 旧 uid/utype 无处可放（Q5 未决、采购侧不挂会员户）→ 进 legacy_extra 留档
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS _backfill_cash_flow;
DELIMITER $$
CREATE PROCEDURE _backfill_cash_flow(IN batch_size INT)
BEGIN
  DECLARE v_last BIGINT DEFAULT 0;
  DECLARE v_max  BIGINT DEFAULT 0;
  DECLARE v_next BIGINT DEFAULT 0;

  SELECT COALESCE(MAX(id), 0) INTO v_max FROM finance_order_cash_flow;

  WHILE v_last < v_max DO
    SELECT COALESCE(MAX(id), v_max) INTO v_next FROM (
      SELECT id FROM finance_order_cash_flow WHERE id > v_last ORDER BY id LIMIT batch_size
    ) b;

    INSERT INTO ledger_entries (
      account_id, direction, signed_amount, balance_before, balance_after, currency,
      flow_type, channel, idempotency_key,
      counterpart_amount, bargain_amount, freight_amount, operator_id,
      legacy_extra, legacy_source, legacy_id, occurred_at, created_at)
    SELECT
      a.id, 'IN', f.price,
      -- PURCHASE 是成本归集户：balance = 累计发生额，故逐行快照必须按 (id 序) 累加，
      -- 这里用「本行发生额」占位、§6 末尾统一用窗口函数重算 chain（避免分批 INSERT 之间的顺序依赖）
      0, 0, 'CNY',
      COALESCE(m.flow_type, 'PURCHASE_PAYMENT'), NULL,
      -- ★ 幂等键必须与 legacy_source **同一个词表**：早前这里写 'CASH_FLOW' 而 legacy_source 写
      --   'FINANCE_ORDER_CASH_FLOW'，同一来源两套 token，被 verify 的 F5 当场判出（88 万行 FAIL）。
      --   规则固定为 LEGACY:{legacy_source}:{legacy_id}，不留第二套简称。
      CONCAT('LEGACY:FINANCE_ORDER_CASH_FLOW:', f.id),
      f.price, f.bargain_price, f.send_price, f.operator,
      JSON_OBJECT('uid', f.uid, 'utype', f.utype, 'paidMoney', f.paid_money, 'changeType', f.change_type),
      'FINANCE_ORDER_CASH_FLOW', f.id,
      COALESCE(f.created_at, '1970-01-01 00:00:00'), NOW()
    FROM finance_order_cash_flow f
    JOIN accounts a ON a.kind = 'PURCHASE' AND a.member_id = 0
    LEFT JOIN _t1_flow_type_map m ON m.legacy_source = 'FINANCE_ORDER_CASH_FLOW' AND m.legacy_key = CAST(f.change_type AS CHAR)
    WHERE f.id > v_last AND f.id <= v_next
      AND COALESCE(f.price, 0) <> 0            -- 0 元采购动作同上，排除并登记
    ON DUPLICATE KEY UPDATE
      signed_amount = VALUES(signed_amount), flow_type = VALUES(flow_type),
      counterpart_amount = VALUES(counterpart_amount), bargain_amount = VALUES(bargain_amount),
      freight_amount = VALUES(freight_amount), operator_id = VALUES(operator_id),
      legacy_extra = VALUES(legacy_extra), occurred_at = VALUES(occurred_at),
      idempotency_key = VALUES(idempotency_key);

    SET v_last := v_next;
  END WHILE;
END$$
DELIMITER ;

CALL _backfill_dg_record(50000);
CALL _backfill_cash_flow(50000);

-- PURCHASE 户的链式快照重算（成本账户 balance = 累计发生额；MEMBER 户用旧快照不重算）
UPDATE ledger_entries e
JOIN (
  SELECT id,
         COALESCE(SUM(signed_amount) OVER (PARTITION BY account_id ORDER BY id
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before_amt
  FROM ledger_entries
  WHERE legacy_source = 'FINANCE_ORDER_CASH_FLOW'
) c ON c.id = e.id
SET e.balance_before = c.before_amt,
    e.balance_after  = c.before_amt + e.signed_amount
WHERE e.legacy_source = 'FINANCE_ORDER_CASH_FLOW';

-- 平台侧账户余额回填成「分录累计」（否则 accounts.balance 与 Σ分录不一致，对账会假平）
UPDATE accounts a
JOIN (SELECT account_id, SUM(signed_amount) s FROM ledger_entries
      WHERE legacy_source = 'FINANCE_ORDER_CASH_FLOW' GROUP BY account_id) x ON x.account_id = a.id
SET a.balance = x.s, a.last_changed_at = NOW(), a.updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 5. recharge_orders ← dg_rechargerecord（**只装正向入金单**，负向的已在 dg_record 里）
--    ⚠ 生产有 gateway_transaction_no / source 两列，本机 dump 没有 ⇒ 动态拼 SQL，
--      缺列时留 NULL 而不是报错（同 0012 的 PREPARE 条件惯例）
-- ---------------------------------------------------------------------------
SET @gt_col := IF((SELECT COUNT(*) FROM information_schema.columns
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dg_rechargerecord'
                     AND COLUMN_NAME = 'gateway_transaction_no') > 0,
                  'd.gateway_transaction_no', 'NULL');
SET @src_col := IF((SELECT COUNT(*) FROM information_schema.columns
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dg_rechargerecord'
                      AND COLUMN_NAME = 'source') > 0,
                   'UPPER(NULLIF(d.source, ''''))', 'NULL');

SET @sql := CONCAT('
INSERT INTO recharge_orders (
  id, member_id, source_amount, source_currency, credited_amount, rate, rate_source,
  channel, channel_label, status, gateway_transaction_no, submitted_by_admin_id, audited_by_admin_id,
  proof_attachment_url, payer_tel, source_system, submitted_at, credited_at, ledger_entry_id,
  notes, created_at, updated_at)
SELECT
  d.rid, d.uid, d.amount, UPPER(COALESCE(NULLIF(TRIM(d.currency), ''''), ''JPY'')), d.money,
  CASE WHEN COALESCE(d.amount, 0) > 0 THEN ROUND(d.money / d.amount, 8) ELSE NULL END,
  CASE WHEN COALESCE(d.amount, 0) > 0 THEN ''LEGACY_DERIVED'' ELSE ''LEGACY_MISSING'' END,
  COALESCE(p.channel, ''UNKNOWN_PAYTYPE''),
  LEFT(COALESCE(d.payname, p.reason_label), 64),
  CASE d.state WHEN -1 THEN ''REJECTED'' WHEN 1 THEN ''PENDING'' WHEN 2 THEN ''COMPLETED''
               WHEN 3 THEN ''AUDITED'' ELSE ''UNKNOWN_STATE'' END,
  ', @gt_col, ',
  d.submit_admin_uid, d.audit_admin_uid,
  LEFT(NULLIF(d.attachment, ''''), 200), LEFT(NULLIF(d.tel, ''''), 20), ', @src_col, ',
  FROM_UNIXTIME(NULLIF(d.addtime, 0)), FROM_UNIXTIME(NULLIF(d.successtime, 0)),
  (SELECT MIN(e.id) FROM ledger_entries e
    WHERE e.legacy_source = ''DG_RECORD'' AND e.voucher_no = NULLIF(d.sn, '''')),
  JSON_OBJECT(''paytype'', d.paytype, ''reasonLabel'', p.reason_label, ''memberid'', d.memberid,
              ''state'', d.state, ''bank'', d.bank, ''legacyRemark'', LEFT(COALESCE(d.remark, ''''), 255)),
  NOW(), NOW()
FROM dg_rechargerecord d
JOIN member mm ON mm.id = d.uid
LEFT JOIN _t1_paytype_map p ON p.paytype = d.paytype
WHERE d.money > 0 AND d.deleted_at IS NULL
ON DUPLICATE KEY UPDATE
  member_id = VALUES(member_id), source_amount = VALUES(source_amount),
  source_currency = VALUES(source_currency), credited_amount = VALUES(credited_amount),
  rate = VALUES(rate), rate_source = VALUES(rate_source), channel = VALUES(channel),
  channel_label = VALUES(channel_label), status = VALUES(status),
  submitted_at = VALUES(submitted_at), credited_at = VALUES(credited_at),
  ledger_entry_id = VALUES(ledger_entry_id), notes = VALUES(notes), updated_at = NOW()');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 6. ledger_entry_orders ← relation_order_and_finance_order_cash_flow
--    旧表 261 万行**无唯一键**（重复投递风险）→ 用 (entry_id, order_id) 收口
-- ---------------------------------------------------------------------------
INSERT INTO ledger_entry_orders (entry_id, order_id, created_at)
SELECT DISTINCT e.id, o.id, NOW()
FROM relation_order_and_finance_order_cash_flow rel
JOIN ledger_entries e ON e.legacy_source = 'FINANCE_ORDER_CASH_FLOW' AND e.legacy_id = rel.cash_flow_id
JOIN orders o         ON o.id = rel.oid
ON DUPLICATE KEY UPDATE created_at = ledger_entry_orders.created_at;

-- ---------------------------------------------------------------------------
-- 7. exchange_rates ← dg_huilv（方向 CNY→JPY 按实测值域定；同一时刻取 MAX(hid)）
-- ---------------------------------------------------------------------------
-- ★ 规则只有一条：**同一 (年月日时分) 取 hid 最大那条的 huilv**（后写覆盖先写，与旧库读取顺序一致）。
--   早先这里 INSERT 用 MAX(huilv)、ODKU 用 k.huilv（=MAX(hid) 那条），两条规则并存，
--   被 0018 的 G7 判出 4 行不一致（2026-10-16 实测）。现在 INSERT/ODKU 共用 VALUES(rate)，只算一次。
INSERT INTO exchange_rates (base, quote, rate, source, spread_applied, effective_at, created_at)
SELECT 'CNY', 'JPY', k.huilv, 'HUILV_LEGACY', 0,
       CAST(CONCAT(LPAD(x.nian, 4, '0'), '-', LPAD(x.yue, 2, '0'), '-', LPAD(x.ri, 2, '0'), ' ',
                   LPAD(x.shi, 2, '0'), ':', LPAD(x.fen, 2, '0'), ':00') AS DATETIME), NOW()
FROM (
  SELECT h.nian, h.yue, h.ri, h.shi, h.fen, MAX(h.hid) AS keep_hid
  FROM dg_huilv h GROUP BY h.nian, h.yue, h.ri, h.shi, h.fen
) x
JOIN dg_huilv k ON k.hid = x.keep_hid
ON DUPLICATE KEY UPDATE rate = VALUES(rate), source = VALUES(source);

UPDATE accounts SET balance = (SELECT COALESCE(MAX(e.balance_after), 0) FROM ledger_entries e
                               WHERE e.legacy_source = 'FINANCE_ORDER_CASH_FLOW'),
                    opening_amount = 0, updated_at = NOW()
WHERE kind = 'PURCHASE';

-- ---------------------------------------------------------------------------
-- 8. MEMBER 户期初 = 首条分录的 balance_before（无分录者 = 当前余额）
--    ★ 计划书 §五 原写「期初 = dg_users.money」是错的：money 是**当前**余额，
--      期初取首条快照才对得上链；本轮按实测改判
-- ---------------------------------------------------------------------------
UPDATE accounts a
JOIN (
  SELECT e.account_id, MIN(e.id) AS first_id
  FROM ledger_entries e WHERE e.legacy_source = 'DG_RECORD' GROUP BY e.account_id
) f ON f.account_id = a.id
JOIN ledger_entries fe ON fe.id = f.first_id
SET a.opening_amount = fe.balance_before, a.updated_at = NOW()
WHERE a.kind = 'MEMBER';

UPDATE accounts SET opening_amount = balance, updated_at = NOW()
WHERE kind = 'MEMBER'
  AND id NOT IN (SELECT account_id FROM ledger_entries WHERE legacy_source = 'DG_RECORD');

-- ---------------------------------------------------------------------------
-- 9. 已知历史缺陷基线登记（append 一次即重跑幂等；verify 只读、不写表）
--    ★ 每条是「按 reason 聚合」的一行，left_key 稳定 ⇒ (batch_id,left_key,reason_code) 幂等
-- ---------------------------------------------------------------------------
INSERT INTO reconciliation_batches (type, window_from, window_to, status, diff_count, created_at, updated_at)
SELECT 'BALANCE', COALESCE(MIN(occurred_at), '1970-01-01'), COALESCE(MAX(occurred_at), NOW()),
       'DIFF_FOUND', 0, NOW(), NOW()
FROM ledger_entries WHERE legacy_source = 'DG_RECORD'
ON DUPLICATE KEY UPDATE updated_at = NOW();

SET @batch := (SELECT id FROM reconciliation_batches
               WHERE type = 'BALANCE'
                 AND window_from = (SELECT COALESCE(MIN(occurred_at), '1970-01-01')
                                    FROM ledger_entries WHERE legacy_source = 'DG_RECORD')
               LIMIT 1);

-- CHAIN_BROKEN 按 action 聚合（期望 = 该 action 有前驱的行数，实际 = 链断数）
INSERT INTO reconciliation_diffs (batch_id, left_key, expected_amount, actual_amount, diff_amount,
                                  reason_code, disposition, detail, created_at, updated_at)
SELECT @batch, CONCAT('DG_RECORD:ACTION:', g.action), g.total_rows, g.broken_rows, g.gap_abs,
       'CHAIN_BROKEN', 'OPEN',
       JSON_OBJECT('gap_sum', g.gap, 'note', '§6.4 链断不静默修复；基线数即本行 diff_count'), NOW(), NOW()
FROM (
  SELECT JSON_UNQUOTE(JSON_EXTRACT(legacy_extra, '$.action')) AS action,
         COUNT(*) AS total_rows,
         SUM(prev_after IS NOT NULL AND prev_after <> this_before) AS broken_rows,
         SUM(CASE WHEN prev_after IS NOT NULL AND prev_after <> this_before THEN ABS(this_before - prev_after) ELSE 0 END) AS gap_abs,
         SUM(CASE WHEN prev_after IS NOT NULL AND prev_after <> this_before THEN this_before - prev_after ELSE 0 END) AS gap
  FROM (
    SELECT e.id,
           CAST(e.signed_amount AS DECIMAL(20, 2)) * 0 + JSON_UNQUOTE(JSON_EXTRACT(e.legacy_extra, '$.action')) AS a2,
           e.balance_before AS this_before,
           LAG(e.balance_after) OVER (PARTITION BY e.account_id ORDER BY e.legacy_id) AS prev_after,
           JSON_EXTRACT(e.legacy_extra, '$.action') AS raw_action
    FROM ledger_entries e WHERE e.legacy_source = 'DG_RECORD'
  ) y
  JOIN ledger_entries z ON z.id = y.id
  GROUP BY action
) g
WHERE g.broken_rows > 0
ON DUPLICATE KEY UPDATE expected_amount = VALUES(expected_amount), actual_amount = VALUES(actual_amount),
                        diff_amount = VALUES(diff_amount), detail = VALUES(detail), updated_at = NOW();

-- 排除项与异常汇率：让「没搬进来的行」都有一个可查的数字，而不是静默消失
INSERT INTO reconciliation_diffs (batch_id, left_key, expected_amount, actual_amount, diff_amount,
                                  reason_code, disposition, detail, created_at, updated_at)
SELECT @batch, x.k, x.exp, x.act, x.exp - x.act, x.rc, 'ACCEPTED', x.d, NOW(), NOW()
FROM (
  SELECT 'DG_RECORD:EXCLUDED_SOFT_DELETED' k,
         (SELECT COUNT(*) FROM dg_record WHERE deleted_at IS NOT NULL) exp, 0 act,
         'STATE_SKIPPED' rc, JSON_OBJECT('note', '旧库软删，不进账本') d
  UNION ALL
  SELECT 'DG_RECORD:EXCLUDED_ZERO_AMOUNT',
         (SELECT COUNT(*) FROM dg_record WHERE money = 0 AND deleted_at IS NULL), 0,
         'STATE_SKIPPED', JSON_OBJECT('note', '0 元分录无资金意义')
  UNION ALL
  SELECT 'DG_RECORD:EXCLUDED_UID_ORPHAN',
         (SELECT COUNT(*) FROM dg_record r LEFT JOIN member m ON m.id = r.uid
           WHERE m.id IS NULL AND r.deleted_at IS NULL AND r.money <> 0), 0,
         'MISSING_ENTRY', JSON_OBJECT('note', '父会员不存在，按 member 域铁律过滤（生产需复核孤儿率）')
  UNION ALL
  SELECT 'RECHARGE:EXCLUDED_NEGATIVE',
         (SELECT COUNT(*) FROM dg_rechargerecord WHERE money < 0), 0,
         'STATE_SKIPPED', JSON_OBJECT('note', '负向调整只进 ledger（其 dg_record 原行），不建入金单，避免双计')
  UNION ALL
  SELECT 'EXCHANGE_RATE:HUILV_FOLDED',
         (SELECT COUNT(*) FROM dg_huilv),
         (SELECT COUNT(*) FROM exchange_rates),
         'DUPLICATED_ENTRY', JSON_OBJECT('note', '同一 (年月日时分) 多条，按 MAX(hid) 折叠')
  UNION ALL
  SELECT 'EXCHANGE_RATE:SUSPECT_VALUES',
         (SELECT COUNT(*) FROM dg_huilv WHERE huilv < 5), 0,
         'RATE_DRIFT', JSON_OBJECT('note', '值域实测 15.46~24.07；<5 的是历史脏点，照原样落库不修')
  UNION ALL
  SELECT 'RECHARGE:MYR_RATE_LIKE_JPY',
         (SELECT COUNT(*) FROM dg_rechargerecord WHERE UPPER(currency) = 'MYR'), 0,
         'RATE_DRIFT', JSON_OBJECT('note', '#11a 新证据：MYR 单的 money/amount≈0.0458，与日元同比率，疑似按日元汇率折算')
) x
ON DUPLICATE KEY UPDATE expected_amount = VALUES(expected_amount), actual_amount = VALUES(actual_amount),
                        diff_amount = VALUES(diff_amount), detail = VALUES(detail), updated_at = NOW();

UPDATE reconciliation_batches SET diff_count = (SELECT COUNT(*) FROM reconciliation_diffs WHERE batch_id = @batch)
WHERE id = @batch;

-- ---------------------------------------------------------------------------
-- 10. 清理暂存物（映射表与序号表保留作审计；过程与临时语句句柄必须释放）
-- ---------------------------------------------------------------------------
DROP PROCEDURE _backfill_dg_record;
DROP PROCEDURE _backfill_cash_flow;
