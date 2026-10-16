-- ============================================================================
-- 本地演练专用（0016）：导入 **finance 域** 旧源表到当前演练库
--
-- ⚠ 生产 T1 不需要本脚本（源表与目标表同库）。惯例同 `0014` / `0006` / `0010`。
--
-- 覆盖（5 张，全部在本机 `taotaro` 存在）：
--   dg_record                                 客户侧分录主体（本机 502,167 行 / 生产 8,073,550）
--   dg_rechargerecord                         入金单据（本机 34,929 行 / 生产 59 万）
--   finance_order_cash_flow                   采购侧流水（本机 884,653 行 / 生产 102 万）
--   relation_order_and_finance_order_cash_flow 分录↔订单多对多（本机 261 万，无唯一键）
--   dg_huilv                                  汇率时间序列（本机 76,623 行）
--
-- ⚠ 本机**不存在**、因而记账为 SKIP 的两族表（这是「本地演练无法判定」的实证，不是脚本缺陷）：
--   · `dg_record_old`（5,987,115 行，生产已停写归档）→ §八 Q2「并入与否」**本地无从验证**
--   · `v2_worldfirst_*` 四表 → §八 Q13「WorldFirst 是否在产」**需生产只读通道复核**
--   · `dg_rechargerecord.gateway_transaction_no` / `source` 两列：生产有（`taotaro.sql:1861`），
--     **本机 dump 无此列** ⇒ 渠道幂等键的非 NULL 率只能到生产查（§九-⑥）
--
-- ★ 与 `0014` 的差别：本域表都很大，逐表 `INSERT..SELECT *` 会跑几分钟，
--   故本脚本只做「结构 + 全量搬运 + 行数审计」，不做任何清洗。清洗规则在 `0017`。
--
-- ⚠ 安全守卫：脚本会 DROP 目标表，禁在源库（taotaro / crossbuy_dryrun）里执行。
-- ============================================================================

DROP PROCEDURE IF EXISTS _drill_safety_guard;
DELIMITER $$
CREATE PROCEDURE _drill_safety_guard()
BEGIN
  IF DATABASE() IN ('taotaro', 'crossbuy_dryrun') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '0016 ABORT: refuse to run inside a source library (it DROPs tables). Use e.g. crossbuy_t1v.';
  END IF;
END$$
DELIMITER ;
CALL _drill_safety_guard();

DROP TABLE IF EXISTS _drill_import_log;
CREATE TABLE _drill_import_log (
  tbl           VARCHAR(64) PRIMARY KEY,
  source_schema VARCHAR(64) NULL,
  source_rows   INT NULL,
  note          VARCHAR(96) NULL,
  copied_at     DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0)
) ENGINE = InnoDB;

DROP PROCEDURE IF EXISTS _drill_copy;
DELIMITER $$
CREATE PROCEDURE _drill_copy(IN p_table VARCHAR(64))
BEGIN
  DECLARE v_schema VARCHAR(64) DEFAULT NULL;
  DECLARE v_rows   INT DEFAULT 0;

  -- 择优取源：taotaro（生产形状）优先，其次 crossbuy_dryrun 的手工副本
  SELECT table_schema INTO v_schema
  FROM information_schema.tables
  WHERE table_name = p_table
    AND table_schema IN ('taotaro', 'crossbuy_dryrun')
  ORDER BY FIELD(table_schema, 'taotaro', 'crossbuy_dryrun')
  LIMIT 1;

  IF v_schema IS NULL THEN
    INSERT INTO _drill_import_log (tbl, source_schema, source_rows, note)
    VALUES (p_table, NULL, NULL, 'SKIP: absent locally (see header)');
  ELSE
    SET @s = CONCAT('DROP TABLE IF EXISTS `', p_table, '`');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

    SET @s = CONCAT('CREATE TABLE `', p_table, '` LIKE `', v_schema, '`.`', p_table, '`');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

    SET @s = CONCAT('INSERT INTO `', p_table, '` SELECT * FROM `', v_schema, '`.`', p_table, '`');
    PREPARE st FROM @s;
    EXECUTE st;
    -- ★ ROW_COUNT() 必须紧跟 EXECUTE：DEALLOCATE 会把它重置成 0（0014 踩过，审计一度全报 0 行）
    SET v_rows := ROW_COUNT();
    DEALLOCATE PREPARE st;

    INSERT INTO _drill_import_log (tbl, source_schema, source_rows, note)
    VALUES (p_table, v_schema, v_rows, IF(v_schema = 'taotaro', 'from production-shaped dump', 'from legacy dryrun copy'));
  END IF;
END$$
DELIMITER ;

CALL _drill_copy('dg_record');
CALL _drill_copy('dg_rechargerecord');
CALL _drill_copy('finance_order_cash_flow');
CALL _drill_copy('relation_order_and_finance_order_cash_flow');
CALL _drill_copy('dg_huilv');
-- 下面两族本机没有，调用它们只会在审计里留下 SKIP 行（生产 T1 不需要搬运，脚本不进生产）
CALL _drill_copy('dg_record_old');
CALL _drill_copy('v2_worldfirst_quota');

DROP PROCEDURE _drill_copy;
DROP PROCEDURE _drill_safety_guard;

-- ---------------------------------------------------------------------------
-- 落地自检
-- ---------------------------------------------------------------------------
SELECT 'J1 应建成的 5 张表' AS check_name, 5 AS expected,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN ('dg_record','dg_rechargerecord','finance_order_cash_flow',
                             'relation_order_and_finance_order_cash_flow','dg_huilv')) AS actual,
       IF((SELECT COUNT(*) FROM information_schema.tables
           WHERE table_schema = DATABASE()
             AND table_name IN ('dg_record','dg_rechargerecord','finance_order_cash_flow',
                                'relation_order_and_finance_order_cash_flow','dg_huilv')) = 5,
          'PASS', 'FAIL') AS result
UNION ALL
SELECT 'J2 本机缺失表被如实记为 SKIP(2 族)', 2,
       (SELECT COUNT(*) FROM _drill_import_log WHERE source_schema IS NULL),
       IF((SELECT COUNT(*) FROM _drill_import_log WHERE source_schema IS NULL) = 2, 'PASS', 'FAIL')
UNION ALL
-- 生产有、本机 dump 无的列：这里必须是 0，否则说明连列名都对不上生产语义
SELECT 'J3 本机 dg_rechargerecord 无 gateway_transaction_no 列', 0,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'dg_rechargerecord'
          AND column_name = 'gateway_transaction_no'),
       IF((SELECT COUNT(*) FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'dg_rechargerecord'
            AND column_name = 'gateway_transaction_no') = 0, 'PASS', 'WARN: 本机已有该列，0017 的幂等键断言可加严');

SELECT tbl, source_schema, source_rows, note FROM _drill_import_log ORDER BY tbl;
