-- ============================================================================
-- 本地演练专用（0014）：导入 **member 域** 旧源表到当前演练库，让它能从零复现
--
-- ⚠ 生产 T1 **不需要**本脚本：生产环境源表与目标表同库（taotaro），
--   回填脚本 0002/0004 直接用裸表名执行。本脚本只为解决 TODO #3g④：
--   前几轮 member 演练的旧表副本是**手工**建的，演练库一旦重建，③⑤ 就无从起跑。
--
-- 命名/惯例对齐 `0006-order-source-import.sql`、`0010-send-order-source-import.sql`。
--
-- ★ 2026-10-15 复跑发现的实情（决定了本脚本为什么要做动态择优，而不是照抄 0006）：
--   本机 15 张 member 域旧源表**并不全在 `taotaro` 里**——
--     · `taotaro`（DBX 导出的旧版 dump，160 张表）**缺 4 张**：
--       `v2_member_webhook` / `v2_member_webhook_delivery` / `user_benefit_configs` / `user_benefits`
--     · 这 4 张只存在于 `crossbuy_dryrun` 的手工副本里（结构按线上 information_schema 核对过，
--       见 README「第二批侧表回填要点」的 122 列/13 表）
--   照抄 0006 的 `CREATE TABLE LIKE taotaro.x` 会在第 4 张表上 `ERROR 1146` 硬停。
--   ⇒ 每张表按 **taotaro → crossbuy_dryrun** 的优先级择优取源，并在
--     `_drill_import_log` 里留「来源库 + 行数」的审计记录；两张都没有才记 SKIP。
--
-- ⚠ 安全守卫：本脚本**禁止在源库里执行**（`taotaro` / `crossbuy_dryrun` 内直接 SIGNAL 中止）。
--   它会对每张目标表先 `DROP TABLE`，若误在源库里跑就会毁掉副本数据。
--
-- ⚠ 与 0006 的另一处差异：本机 `taotaro` 是**旧版 dump**，`dg_users` 只有 74 列，
--   而生产 `dg_users` 实为 75 列（多 `biz_code`，2026-10-13 按线上 information_schema 核对，
--   见 docs/plans/member-迁移与共存.md §修订）。`0002` 会读 `biz_code` → 建表后用
--   information_schema 探测补列，留 NULL 默认（正好压测 0002 的 COALESCE(NULLIF(...)) 兜底）。
--   ⇒ 这条纯粹是「本机 dump 落后于生产」的补丁，生产不需要。
--
-- ⚠ 纪律：演练库里可能有真实账号结构，禁导出、禁提交、禁写回任何源库。
--
-- 覆盖 15 张 = 0002 的 2 张核心 + 0004 的 13 张侧表源：
--   dg_users · dg_address · v2_member_webhook · v2_member_webhook_delivery
--   v2_oauth_login · v2_oauth_taobao_global · v2_favorite · v2_favorite_category
--   v2_user_browse_history · v2_area · user_benefit_configs · user_benefits
--   user_operation_log · v2_personal_access_tokens · v2_open_api_idempotency
--
-- 执行顺序：0001 → 0001a → **0014** → 0002 → 0003 → 0004 → 0005
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 安全守卫：禁在源库里跑（本脚本会 DROP 目标表）
-- ---------------------------------------------------------------------------
DROP PROCEDURE IF EXISTS _drill_safety_guard;
DELIMITER $$
CREATE PROCEDURE _drill_safety_guard()
BEGIN
  IF DATABASE() IN ('taotaro', 'crossbuy_dryrun') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '0014 ABORT: refuse to run inside a source library (it DROPs tables). Use: mysql ... <db_name> (e.g. crossbuy_t1v).';
  END IF;
END$$
DELIMITER ;
CALL _drill_safety_guard();

-- ---------------------------------------------------------------------------
-- 1. 复制过程 + 审计日志
--    _drill_copy(表名)：择优取源 -> DROP/CREATE LIKE/INSERT SELECT * -> 记日志
--    行数用 ROW_COUNT()（INSERT..SELECT 的实际搬运量），不是 information_schema 的估算值
-- ---------------------------------------------------------------------------
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

  SELECT table_schema INTO v_schema
  FROM information_schema.tables
  WHERE table_name = p_table
    AND table_schema IN ('taotaro', 'crossbuy_dryrun')
  ORDER BY FIELD(table_schema, 'taotaro', 'crossbuy_dryrun')
  LIMIT 1;

  IF v_schema IS NULL THEN
    INSERT INTO _drill_import_log (tbl, source_schema, source_rows, note)
    VALUES (p_table, NULL, NULL, 'SKIP: not present in taotaro nor crossbuy_dryrun');
  ELSE
    SET @s = CONCAT('DROP TABLE IF EXISTS `', p_table, '`');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

    SET @s = CONCAT('CREATE TABLE `', p_table, '` LIKE `', v_schema, '`.`', p_table, '`');
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

    SET @s = CONCAT('INSERT INTO `', p_table, '` SELECT * FROM `', v_schema, '`.`', p_table, '`');
    PREPARE st FROM @s;
    EXECUTE st;
    -- ★ ROW_COUNT() 必须紧跟 EXECUTE 取：DEALLOCATE PREPARE 也是「最后一条语句」，
    --   放它后面会把搬运行数读成 0（2026-10-15 复跑实测踩过，审计日志一度全绿假零）
    SET v_rows := ROW_COUNT();
    DEALLOCATE PREPARE st;

    INSERT INTO _drill_import_log (tbl, source_schema, source_rows, note)
    VALUES (p_table, v_schema, v_rows,
            IF(v_schema = 'taotaro', 'from production-shaped dump', 'from legacy dryrun copy'));
  END IF;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------------
-- 2. 核心两表
-- ---------------------------------------------------------------------------
CALL _drill_copy('dg_users');
CALL _drill_copy('dg_address');

-- 补列守卫（本机 taotaro 缺生产实有的 biz_code；从 dryrun 副本取源时该列已在）
SET @s := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dg_users' AND COLUMN_NAME = 'biz_code') = 0,
  'ALTER TABLE dg_users ADD COLUMN biz_code VARCHAR(56) NULL DEFAULT NULL',
  'SELECT ''biz_code already present: skip ALTER'' AS drill_note');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ---------------------------------------------------------------------------
-- 3. 侧表源表（13 张，字段与 0004 逐列同名，仅 uid -> member_id）
-- ---------------------------------------------------------------------------
CALL _drill_copy('v2_member_webhook');
CALL _drill_copy('v2_member_webhook_delivery');
CALL _drill_copy('v2_oauth_login');
CALL _drill_copy('v2_oauth_taobao_global');
CALL _drill_copy('v2_favorite');
CALL _drill_copy('v2_favorite_category');
CALL _drill_copy('v2_user_browse_history');
CALL _drill_copy('v2_area');
CALL _drill_copy('user_benefit_configs');
CALL _drill_copy('user_benefits');
CALL _drill_copy('user_operation_log');
CALL _drill_copy('v2_personal_access_tokens');
CALL _drill_copy('v2_open_api_idempotency');

DROP PROCEDURE _drill_copy;
DROP PROCEDURE _drill_safety_guard;

-- ---------------------------------------------------------------------------
-- 4. 落地自检（三条硬判据，任一不满足就别往下跑回填）
-- ---------------------------------------------------------------------------
-- ① 15 张全在、无 SKIP
SELECT 'I1 目标表建成数(应 15)' AS check_name, 15 AS expected,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN ('dg_users','dg_address','v2_member_webhook','v2_member_webhook_delivery',
                             'v2_oauth_login','v2_oauth_taobao_global','v2_favorite','v2_favorite_category',
                             'v2_user_browse_history','v2_area','user_benefit_configs','user_benefits',
                             'user_operation_log','v2_personal_access_tokens','v2_open_api_idempotency')) AS actual,
       IF((SELECT COUNT(*) FROM information_schema.tables
           WHERE table_schema = DATABASE()
             AND table_name IN ('dg_users','dg_address','v2_member_webhook','v2_member_webhook_delivery',
                                'v2_oauth_login','v2_oauth_taobao_global','v2_favorite','v2_favorite_category',
                                'v2_user_browse_history','v2_area','user_benefit_configs','user_benefits',
                                'user_operation_log','v2_personal_access_tokens','v2_open_api_idempotency')) = 15,
          'PASS', 'FAIL') AS result
UNION ALL
-- ② 审计日志 15 行、source_schema 全非 NULL
SELECT 'I2 无 SKIP 的源表数', 15, COUNT(source_schema), IF(COUNT(source_schema) = 15, 'PASS', 'FAIL')
FROM _drill_import_log
UNION ALL
-- ③ dg_users 有 biz_code（0002 要读它）
SELECT 'I3 dg_users.biz_code 存在', 1,
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'dg_users' AND column_name = 'biz_code'),
       IF((SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'dg_users' AND column_name = 'biz_code') = 1,
          'PASS', 'FAIL');

-- 搬运审计：来源库与行数（源=演练库自身那一列必等，因为是 INSERT..SELECT 的实测行数）
SELECT tbl, source_schema, source_rows, note FROM _drill_import_log ORDER BY tbl;
