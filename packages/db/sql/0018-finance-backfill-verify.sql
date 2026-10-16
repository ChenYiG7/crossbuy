-- ============================================================================
-- T1 回填一致性校验（finance 段，**只读断言**，跑完 0017 后必跑）
--
-- ★ 本脚本的立身之本（#3g② 的教训，docs/plans/03 §9.4/§9.7）：
--   每条断言的 expected 与 actual 必须**从两个独立来源各算一次**——
--   一边数旧源表、一边数新表，绝不把上一次跑出来的数字写死在这里。
--   「结构跑通、数字全零」也是假绿：任何 0 都要能说出它是谁减谁得到的。
--
-- ⚠ 本机是**尾切片**（taotaro dump 只有 5,021 个会员 / dg_record 502,167 行），
--   因此「回链率」「末条快照 = 当前余额」这类依赖全量历史的断言在本地只会是 INFO，
--   生产跑同一份脚本才会变成硬判据。每条都注明了这一点，别把 INFO 当 PASS。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 组 E：行数与金额配平（源侧 vs 新表侧，独立计算）
-- ---------------------------------------------------------------------------
SELECT 'E1 dg_record 侧分录行数 = 源可搬运行数' AS check_name,
       s.n AS expected, t.n AS actual, IF(s.n = t.n, 'PASS', 'FAIL') AS result
FROM (SELECT COUNT(*) AS n FROM dg_record r
      JOIN member m ON m.id = r.uid
      WHERE r.deleted_at IS NULL AND r.money <> 0) s
CROSS JOIN (SELECT COUNT(*) AS n FROM ledger_entries WHERE legacy_source = 'DG_RECORD') t
UNION ALL
SELECT 'E2 cash_flow 侧分录行数 = 源 price<>0 行数', s.n, t.n, IF(s.n = t.n, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS n FROM finance_order_cash_flow WHERE COALESCE(price, 0) <> 0) s
CROSS JOIN (SELECT COUNT(*) AS n FROM ledger_entries WHERE legacy_source = 'FINANCE_ORDER_CASH_FLOW') t
UNION ALL
SELECT 'E3 两侧合计 = 分录总数', s.n, t.n, IF(s.n = t.n, 'PASS', 'FAIL')
FROM (SELECT (SELECT COUNT(*) FROM dg_record r JOIN member m ON m.id = r.uid
              WHERE r.deleted_at IS NULL AND r.money <> 0)
            + (SELECT COUNT(*) FROM finance_order_cash_flow WHERE COALESCE(price,0) <> 0) AS n) s
CROSS JOIN (SELECT COUNT(*) AS n FROM ledger_entries) t
UNION ALL
-- ★ 金额侧配平：只比行数不够，钱要能对上
SELECT 'E4 dg_record 侧金额合计（Σsigned = 源 Σmoney）', s.n, t.n,
       IF(ABS(s.n - t.n) < 0.005, 'PASS', 'FAIL')
FROM (SELECT COALESCE(SUM(r.money), 0) AS n FROM dg_record r JOIN member m ON m.id = r.uid
      WHERE r.deleted_at IS NULL AND r.money <> 0) s
CROSS JOIN (SELECT COALESCE(SUM(signed_amount), 0) AS n FROM ledger_entries
            WHERE legacy_source = 'DG_RECORD') t
UNION ALL
SELECT 'E5 PURCHASE 户余额 = Σ采购分录（= 源 Σprice）', s.n, t.n,
       IF(ABS(s.n - t.n) < 0.005 AND ABS(s.n - u.n) < 0.005, 'PASS', 'FAIL')
FROM (SELECT COALESCE(SUM(price), 0) AS n FROM finance_order_cash_flow WHERE COALESCE(price,0) <> 0) s
CROSS JOIN (SELECT COALESCE(SUM(signed_amount), 0) AS n FROM ledger_entries
            WHERE legacy_source = 'FINANCE_ORDER_CASH_FLOW') t
CROSS JOIN (SELECT balance AS n FROM accounts WHERE kind = 'PURCHASE' AND member_id = 0) u
UNION ALL
SELECT 'E6 MEMBER 户数 = member 行数', s.n, t.n, IF(s.n = t.n, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS n FROM member) s
CROSS JOIN (SELECT COUNT(*) AS n FROM accounts WHERE kind = 'MEMBER') t
UNION ALL
SELECT 'E7 MEMBER 户 Σbalance = Σmember.balance = Σdg_users.money', s.n,
       CONCAT(CAST(t.n AS CHAR), ' / ', CAST(u.n AS CHAR)),
       IF(ABS(s.n - t.n) < 0.005 AND ABS(t.n - u.n) < 0.005, 'PASS', 'FAIL')
FROM (SELECT COALESCE(SUM(money), 0) AS n FROM dg_users) s
CROSS JOIN (SELECT COALESCE(SUM(balance), 0) AS n FROM accounts WHERE kind = 'MEMBER') t
CROSS JOIN (SELECT COALESCE(SUM(balance), 0) AS n FROM member) u;

-- ---------------------------------------------------------------------------
-- 组 F：不变式与词表覆盖（新表内部，期望违规数 = 0）
-- ---------------------------------------------------------------------------
SELECT 'F1 未映射 action 兜底行数（词表漏值）' AS check_name, 0 AS expected,
       (SELECT COUNT(*) FROM ledger_entries WHERE flow_type = 'LEGACY_UNKNOWN_ACTION') AS actual,
       IF((SELECT COUNT(*) FROM ledger_entries WHERE flow_type = 'LEGACY_UNKNOWN_ACTION') = 0,
          'PASS', 'FAIL') AS result
UNION ALL
SELECT 'F2 direction 与符号不一致', 0,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE (direction = 'IN' AND signed_amount < 0)
           OR (direction = 'OUT' AND signed_amount > 0)),
       IF((SELECT COUNT(*) FROM ledger_entries
           WHERE (direction = 'IN' AND signed_amount < 0)
              OR (direction = 'OUT' AND signed_amount > 0)) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'F3 代数不变式 balance_after-before <> signed', 0,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE ABS((balance_after - balance_before) - signed_amount) >= 0.005),
       IF((SELECT COUNT(*) FROM ledger_entries
           WHERE ABS((balance_after - balance_before) - signed_amount) >= 0.005) = 0, 'PASS', 'FAIL')
UNION ALL
-- ★ 旧库 idempotency_key 非 NULL 率是 0%，新库必须 100%（这是「旧系统反例」的正面对照）
SELECT 'F4 幂等键为空的行数', 0,
       (SELECT COUNT(*) FROM ledger_entries WHERE idempotency_key IS NULL OR idempotency_key = ''),
       IF((SELECT COUNT(*) FROM ledger_entries WHERE idempotency_key IS NULL OR idempotency_key = '') = 0,
          'PASS', 'FAIL')
UNION ALL
SELECT 'F5 幂等键与 legacy_id 不对应', 0,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE legacy_id IS NOT NULL
          AND idempotency_key <> CONCAT('LEGACY:', legacy_source, ':', legacy_id)),
       IF((SELECT COUNT(*) FROM ledger_entries
           WHERE legacy_id IS NOT NULL
             AND idempotency_key <> CONCAT('LEGACY:', legacy_source, ':', legacy_id)) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'F6 面值币种非 CNY 的分录', 0,
       (SELECT COUNT(*) FROM ledger_entries WHERE currency <> 'CNY'),
       IF((SELECT COUNT(*) FROM ledger_entries WHERE currency <> 'CNY') = 0, 'PASS', 'FAIL')
UNION ALL
-- ★ 列宽隐式截断只能靠断言抓（严格模式会报错，非严格模式静默丢字符）
SELECT 'F7 字符串超列宽（voucher>64 / logistics_no>64 / flow_type>40）', 0,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE CHAR_LENGTH(COALESCE(voucher_no,'')) > 64
           OR CHAR_LENGTH(COALESCE(logistics_no,'')) > 64
           OR CHAR_LENGTH(flow_type) > 40
           OR CHAR_LENGTH(COALESCE(label,'')) > 255),
       IF((SELECT COUNT(*) FROM ledger_entries
           WHERE CHAR_LENGTH(COALESCE(voucher_no,'')) > 64
              OR CHAR_LENGTH(COALESCE(logistics_no,'')) > 64
              OR CHAR_LENGTH(flow_type) > 40
              OR CHAR_LENGTH(COALESCE(label,'')) > 255) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'F8 label 残留 HTML 标签', 0,
       (SELECT COUNT(*) FROM ledger_entries WHERE label REGEXP '<[a-zA-Z/][^>]*>'),
       IF((SELECT COUNT(*) FROM ledger_entries WHERE label REGEXP '<[a-zA-Z/][^>]*>') = 0, 'PASS', 'FAIL')
UNION ALL
-- ★ sn 分段完整性：# 段数必须与 JSON 数组长度一致（序号表上限 20，超了这里就暴露）
SELECT 'F9 多运单号分段不完整（JSON 段数 <> sn 段数）', 0,
       (SELECT COUNT(*) FROM ledger_entries e
        WHERE e.legacy_source = 'DG_RECORD'
          AND EXISTS (SELECT 1 FROM dg_record r WHERE r.rid = e.legacy_id AND r.action = 3
                      AND r.sn LIKE '%#%')
          AND (e.logistics_nos IS NULL
               OR JSON_LENGTH(e.logistics_nos) <>
                  (SELECT 1 + CHAR_LENGTH(r2.sn) - CHAR_LENGTH(REPLACE(r2.sn, '#', ''))
                   FROM dg_record r2 WHERE r2.rid = e.legacy_id))),
       IF((SELECT COUNT(*) FROM ledger_entries e
           WHERE e.legacy_source = 'DG_RECORD'
             AND EXISTS (SELECT 1 FROM dg_record r WHERE r.rid = e.legacy_id AND r.action = 3
                         AND r.sn LIKE '%#%')
             AND (e.logistics_nos IS NULL
                  OR JSON_LENGTH(e.logistics_nos) <>
                     (SELECT 1 + CHAR_LENGTH(r2.sn) - CHAR_LENGTH(REPLACE(r2.sn, '#', ''))
                      FROM dg_record r2 WHERE r2.rid = e.legacy_id))) = 0, 'PASS', 'FAIL')
UNION ALL
-- 采购侧恒等式（§4.8：最便宜的正确性哨兵，旧库实测 100% 成立）
SELECT 'F10 采购派生恒等式偏差（paid <> price-bargain+freight）', 0,
       (SELECT COUNT(*) FROM ledger_entries
        WHERE legacy_source = 'FINANCE_ORDER_CASH_FLOW'
          AND ABS(COALESCE(CAST(JSON_EXTRACT(legacy_extra, '$.paidMoney') AS DECIMAL(14,2)), 0)
                  - (COALESCE(counterpart_amount,0) - COALESCE(bargain_amount,0)
                     + COALESCE(freight_amount,0))) >= 0.005),
       IF((SELECT COUNT(*) FROM ledger_entries
           WHERE legacy_source = 'FINANCE_ORDER_CASH_FLOW'
             AND ABS(COALESCE(CAST(JSON_EXTRACT(legacy_extra, '$.paidMoney') AS DECIMAL(14,2)), 0)
                     - (COALESCE(counterpart_amount,0) - COALESCE(bargain_amount,0)
                        + COALESCE(freight_amount,0))) >= 0.005) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'F11 ledger_entry_orders 两侧悬空', 0,
       (SELECT COUNT(*) FROM ledger_entry_orders lo
        LEFT JOIN ledger_entries e ON e.id = lo.entry_id
        LEFT JOIN orders o ON o.id = lo.order_id
        WHERE e.id IS NULL OR o.id IS NULL),
       IF((SELECT COUNT(*) FROM ledger_entry_orders lo
           LEFT JOIN ledger_entries e ON e.id = lo.entry_id
           LEFT JOIN orders o ON o.id = lo.order_id
           WHERE e.id IS NULL OR o.id IS NULL) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'F12 accounts 非 ACTIVE 户（应全 ACTIVE 除非人工冻结）', 0,
       (SELECT COUNT(*) FROM accounts WHERE status <> 'ACTIVE'),
       IF((SELECT COUNT(*) FROM accounts WHERE status <> 'ACTIVE') = 0, 'PASS', 'FAIL');

-- ---------------------------------------------------------------------------
-- 组 G：单据、汇率与对账基线
-- ---------------------------------------------------------------------------
SELECT 'G1 recharge_orders 行数 = 源正向且父会员存在' AS check_name,
       s.n AS expected, t.n AS actual, IF(s.n = t.n, 'PASS', 'FAIL') AS result
FROM (SELECT COUNT(*) AS n FROM dg_rechargerecord d
      JOIN member m ON m.id = d.uid
      WHERE d.money > 0 AND d.deleted_at IS NULL) s
CROSS JOIN (SELECT COUNT(*) AS n FROM recharge_orders WHERE deleted_at IS NULL) t
UNION ALL
SELECT 'G2 recharge_orders Σcredited = 源同过滤 Σmoney', s.n, t.n,
       IF(ABS(s.n - t.n) < 0.005, 'PASS', 'FAIL')
FROM (SELECT COALESCE(SUM(d.money), 0) AS n FROM dg_rechargerecord d
      JOIN member m ON m.id = d.uid WHERE d.money > 0 AND d.deleted_at IS NULL) s
CROSS JOIN (SELECT COALESCE(SUM(credited_amount), 0) AS n FROM recharge_orders
            WHERE deleted_at IS NULL) t
UNION ALL
-- ★ 反向检查：入金单里不许出现「渠道列混进费用原因」的旧病 —— 渠道词表可枚举
SELECT 'G3 入金单渠道词表越界', 0,
       (SELECT COUNT(*) FROM recharge_orders
        WHERE channel NOT IN ('BANK_TRANSFER','PAYPAL','STRIPE','MANUAL_ADJUST','UNKNOWN_PAYTYPE')),
       IF((SELECT COUNT(*) FROM recharge_orders
           WHERE channel NOT IN ('BANK_TRANSFER','PAYPAL','STRIPE','MANUAL_ADJUST','UNKNOWN_PAYTYPE')) = 0,
          'PASS', 'FAIL')
UNION ALL
-- 反推不出汇率的行必须留 NULL 而不是 0（写 0 会让服务端按 rate 重算出 0 元入账）
SELECT 'G4 rate = 0 的入金单（禁伪造汇率）', 0,
       (SELECT COUNT(*) FROM recharge_orders WHERE rate = 0),
       IF((SELECT COUNT(*) FROM recharge_orders WHERE rate = 0) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'G5 rate 非 NULL 行反推一致（|money/amount - rate| < 1e-6）', 0,
       (SELECT COUNT(*) FROM recharge_orders r JOIN dg_rechargerecord d ON d.rid = r.id
        WHERE r.rate IS NOT NULL AND d.amount > 0
          AND ABS(r.rate - ROUND(d.money / d.amount, 8)) > 0.00000001),
       IF((SELECT COUNT(*) FROM recharge_orders r JOIN dg_rechargerecord d ON d.rid = r.id
           WHERE r.rate IS NOT NULL AND d.amount > 0
             AND ABS(r.rate - ROUND(d.money / d.amount, 8)) > 0.00000001) = 0, 'PASS', 'FAIL')
UNION ALL
SELECT 'G6 exchange_rates 行数 = 源去重时刻数', s.n, t.n, IF(s.n = t.n, 'PASS', 'FAIL')
FROM (SELECT COUNT(*) AS n FROM (SELECT 1 FROM dg_huilv GROUP BY nian, yue, ri, shi, fen) x) s
CROSS JOIN (SELECT COUNT(*) AS n FROM exchange_rates) t
UNION ALL
SELECT 'G7 exchange_rates 与源同刻末条值不符', 0,
       (SELECT COUNT(*) FROM exchange_rates er
        JOIN (SELECT CAST(CONCAT(LPAD(g.nian,4,'0'),'-',LPAD(g.yue,2,'0'),'-',LPAD(g.ri,2,'0'),' ',
                              LPAD(g.shi,2,'0'),':',LPAD(g.fen,2,'0'),':00') AS DATETIME) AS eff_at,
                     MAX(h2.huilv) AS huilv
              FROM (SELECT nian, yue, ri, shi, fen, MAX(hid) AS keep_hid
                    FROM dg_huilv GROUP BY nian, yue, ri, shi, fen) g
              JOIN dg_huilv h2 ON h2.hid = g.keep_hid
              -- ★ 与 0017 §7 同一条规则：同一时刻取 **hid 最大那条** 的 huilv，不是 MAX(huilv)。
              --   早先两边各用一套，4 行差异被误判成回填错误（2026-10-16 实测订正）
              GROUP BY g.nian, g.yue, g.ri, g.shi, g.fen) k
          ON k.eff_at = er.effective_at
        WHERE ABS(er.rate - k.huilv) > 0.00000001) AS actual,
       IF((SELECT COUNT(*) FROM exchange_rates er
           JOIN (SELECT CAST(CONCAT(LPAD(g.nian,4,'0'),'-',LPAD(g.yue,2,'0'),'-',LPAD(g.ri,2,'0'),' ',
                                 LPAD(g.shi,2,'0'),':',LPAD(g.fen,2,'0'),':00') AS DATETIME) AS eff_at,
                        MAX(h2.huilv) AS huilv
                 FROM (SELECT nian, yue, ri, shi, fen, MAX(hid) AS keep_hid
                       FROM dg_huilv GROUP BY nian, yue, ri, shi, fen) g
                 JOIN dg_huilv h2 ON h2.hid = g.keep_hid
                 GROUP BY g.nian, g.yue, g.ri, g.shi, g.fen) k
             ON k.eff_at = er.effective_at
           WHERE ABS(er.rate - k.huilv) > 0.00000001) = 0, 'PASS', 'FAIL') AS result
UNION ALL
-- ★ 两侧独立算链断数：新表侧（LAG 窗口）vs 源侧（LAG 窗口），必须相等
--   这是「回填没改数、也没漏数」最强的那条哨兵
SELECT 'G8 链断基线：新表侧 = 源侧（含 member 过滤后）', s.n, t.n, IF(s.n = t.n, 'PASS', 'FAIL')
FROM (
  SELECT COUNT(*) AS n FROM (
    SELECT r.uid, r.accountmoney - r.money AS tb,
           LAG(r.accountmoney) OVER (PARTITION BY r.uid ORDER BY r.rid) AS pa
    FROM dg_record r JOIN member m ON m.id = r.uid
    WHERE r.deleted_at IS NULL AND r.money <> 0
  ) x WHERE x.pa IS NOT NULL AND x.pa <> x.tb
) s
CROSS JOIN (
  SELECT COUNT(*) AS n FROM (
    SELECT e.account_id, e.balance_before AS tb,
           LAG(e.balance_after) OVER (PARTITION BY e.account_id ORDER BY e.legacy_id) AS pa
    FROM ledger_entries e WHERE e.legacy_source = 'DG_RECORD'
  ) y WHERE y.pa IS NOT NULL AND y.pa <> y.tb
) t
UNION ALL
SELECT 'G9 CHAIN_BROKEN 登记数 = 新表侧链断 action 组数',
       (SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(e.legacy_extra, '$.action')))
        FROM ledger_entries e
        JOIN (SELECT account_id, legacy_id, balance_before,
                     LAG(balance_after) OVER (PARTITION BY account_id ORDER BY legacy_id) pa
              FROM ledger_entries WHERE legacy_source = 'DG_RECORD') c
          ON c.account_id = e.account_id AND c.legacy_id = e.legacy_id
        WHERE c.pa IS NOT NULL AND c.pa <> c.balance_before),
       (SELECT COUNT(*) FROM reconciliation_diffs WHERE reason_code = 'CHAIN_BROKEN'),
       IF((SELECT COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(e.legacy_extra, '$.action')))
           FROM ledger_entries e
           JOIN (SELECT account_id, legacy_id, balance_before,
                        LAG(balance_after) OVER (PARTITION BY account_id ORDER BY legacy_id) pa
                 FROM ledger_entries WHERE legacy_source = 'DG_RECORD') c
             ON c.account_id = e.account_id AND c.legacy_id = e.legacy_id
           WHERE c.pa IS NOT NULL AND c.pa <> c.balance_before)
          = (SELECT COUNT(*) FROM reconciliation_diffs WHERE reason_code = 'CHAIN_BROKEN'),
          'PASS', 'FAIL')
UNION ALL
SELECT 'G10 对账批次 diff_count = 明细行数',
       (SELECT COUNT(*) FROM reconciliation_diffs),
       (SELECT diff_count FROM reconciliation_batches WHERE type = 'BALANCE' LIMIT 1),
       IF((SELECT COUNT(*) FROM reconciliation_diffs)
          = (SELECT diff_count FROM reconciliation_batches WHERE type = 'BALANCE' LIMIT 1),
          'PASS', 'FAIL');

-- ---------------------------------------------------------------------------
-- 组 H：本机只能当 INFO 看的两条（生产全量才有意义，见页首说明）
-- ---------------------------------------------------------------------------
SELECT 'H1 会员末条 balance_after = 当前余额（尾切片下必偏，生产为硬判据)' AS check_name,
       '-' AS expected,
       CONCAT((SELECT COUNT(*) FROM accounts a
               JOIN (SELECT account_id, MAX(legacy_id) mx FROM ledger_entries
                     WHERE legacy_source = 'DG_RECORD' GROUP BY account_id) g ON g.account_id = a.id
               JOIN ledger_entries e ON e.account_id = g.account_id AND e.legacy_id = g.mx
               WHERE a.kind = 'MEMBER' AND ABS(e.balance_after - a.balance) >= 0.005),
              ' / ',
              (SELECT COUNT(*) FROM accounts a
               WHERE a.kind = 'MEMBER'
                 AND EXISTS (SELECT 1 FROM ledger_entries e WHERE e.account_id = a.id
                             AND e.legacy_source = 'DG_RECORD'))) AS actual,
       'INFO' AS result
UNION ALL
SELECT 'H2 入金单回链到分录的比例（sn 匹配；本机尾切片偏低）', '-',
       CONCAT(COALESCE((SELECT COUNT(*) FROM recharge_orders WHERE ledger_entry_id IS NOT NULL), 0),
              ' / ',
              (SELECT COUNT(*) FROM recharge_orders WHERE deleted_at IS NULL)),
       'INFO';

-- 抽样：人工核对金额/时间/词表（生产上线前必看）
SELECT 'H3 客户侧分录抽样 10 行' AS section;
SELECT e.id, e.account_id, e.direction, e.signed_amount, e.balance_before, e.balance_after,
       e.flow_type, LEFT(e.label, 40) AS label40, e.voucher_no, e.legacy_id, e.occurred_at
FROM ledger_entries e WHERE e.legacy_source = 'DG_RECORD'
ORDER BY e.legacy_id DESC LIMIT 10;

SELECT 'H4 采购侧分录抽样 5 行' AS section;
SELECT e.id, e.signed_amount, e.counterpart_amount, e.bargain_amount, e.freight_amount,
       e.balance_before, e.balance_after, JSON_EXTRACT(e.legacy_extra, '$.uid') AS legacy_uid, e.legacy_id
FROM ledger_entries e WHERE e.legacy_source = 'FINANCE_ORDER_CASH_FLOW'
ORDER BY e.legacy_id DESC LIMIT 5;

SELECT 'H5 flow_type 分布（词表落地实况）' AS section;
SELECT flow_type, COUNT(*) AS rows_cnt, CAST(SUM(signed_amount) AS DECIMAL(16,2)) AS sum_signed
FROM ledger_entries GROUP BY flow_type ORDER BY rows_cnt DESC;
