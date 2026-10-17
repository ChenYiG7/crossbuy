# TODO.md — 待办 + 红线与坑

> 约定：清单只装**未完成**项；完成即删除（全文在 git 历史可溯），不打勾留着。
> 编号不复用、不重排。代码里的 `TODO(编号)` 与本清单一一对应。

## 一、待办（P0 → P3）

### P0（本月，最紧急）

- [ ] **#1 山景私有包处置**：~~fork 6 个 `shanjing/*` 包续命~~ **作废（2026-10-16，docs/04 §11，沿 haiou 04 §8 决策）** → PHP 全面冻结（一律不动）+ `vendor/` + `composer.lock` + 部署产物**只读冷备**到公司自有存储；外包/兼职仅 bugfix 止血，且实行**契约变更登记制**（任何改接口行为/字段语义/金额口径的改动必须告知并重录契约基线）
- [ ] **#2 知识盘点**：趁兼职张在，产出 Finance/Order 域业务规则清单 + 外部对接坑 + 对账缺失现状（docs/03 §1.2）
- [ ] **#14 R1 复现期启动（docs/04，2026-10-16 策略转向）**：M0 剩余项 = ① ~~旧库 db pull~~ **✅ 生产 179 表已拉**（2026-10-16 晚：跳板机隧道 + `gouba007` 账号；活跃 schema = 生产 PolarDB `taotaro` MySQL 8.0.18 introspect，`dg_mail1` 是视图无模型、21 张 deprecated 按原样入模；`pull:legacy` = pull + `post-pull-fixup.mjs`（撞名修复 + 头部自愈——pull 会冲掉头部）；冒烟 legacy→生产 `dg_users`=22,628 / `v2_worldfirst_trade_order`=0 双过；provenance + dump 差异全记录见 `docs/plans/07` §三）；② ~~域包骨架~~ **✅ 11 域 + notify 落地**（`scripts/scaffold-domains.mjs` 生成；ESLint 边界规则 = DB 仅 repository / 域间禁 import / contract 纯净；`scripts/boundary-probe.mjs` 故意违规样例 5/5 全拦 + 对照组不误杀）；③ ~~auth Principal/TokenVerifier 抽象~~ **✅**（域服务只认 Principal，三端 verifier 接口）；**剩余**：④ ~~180 表属主域映射~~ **✅ 已完成（M0.5）**——`scripts/classify-table-owners.mjs` 规则化归类（改归属改脚本重跑，文档 §四 为机器产出）+ `--check` 强制**未归类 = 0**；180 对象全覆盖：admin 30 / deprecated 21 / order 18 / member 17 / platform 17 / finance 16 / content 14 / purchase 10 / logistics 8 / send-order 7 / notify 6 / ticket 5 / wms-gateway 5 / infra 3 / openapi 3；**9 张 low 置信待人工裁决**（`dg_examination_record` 系 2 张、`v2_user_platform_account`/`v2_platform_sub_account` 底稿结论分歧、`relation_bill_and_model`、`dg_caizhi`/`dg_trandata`/`dg_ceshi`/`v2_statistics`），明细与分歧点在 07 §四 末尾；⑤ ~~`apps/api`（Fastify）脚手架~~ **✅ 已完成（M0.4）**——zod→OpenAPI（`/docs/json`）、traceId 插件（入参 `X-Trace-Id` 透传）、HMAC 签名 + IP 白名单（CIDR）守卫、统一响应体 `{code,message,data,traceId}`；`/api/open/v1/health` + `/api/webhook/v1/health` 跑通，`pnpm --filter @crossbuy/api smoke` **24 项断言全绿**（含守卫破坏验证：无签名/错签名/超窗时间戳/篡改 body → 401、白名单外 IP → 403、production 缺密钥 → **503 不放行**）；**M0 仅剩 2 项**：vendor 只读冷备（并 #1，需公司存储）+ 部署管线（0.8）；⑥ ~~Vitest 基线 + PHPUnit 打样~~ **✅ 已完成（M0.9）**——`vitest` 5 接入 member 域（`vitest.config.ts` 连 `TEST_DATABASE_URL`，默认本机 dump 库），**4 个用例连真实 MySQL 快照跑通**（事务回滚不污染 dump）；翻译源 = 旧 `EditUserInfoTest`，另加 1 条锁死 `usetype` 枚举真值的回归用例；④ M1 = member 域端到端（契约→route→service→repo→web 会员页）+ 219 PHPUnit 的 member 用例翻译 Vitest + 测试库写路径演练（熔断点）

### P1（阶段 0：基建，第 1 个月）

- [x] **#3 旧库表结构反推**：完成 174 张表盘点（docs/plans/00）+ v2_ 44 张与 finance 流水字段级精读（docs/plans/01）+ member 域 schema 草案（docs/plans/member-schema.md + schema.prisma 17 模型）
- [x] **#3a 关键决策已定**：Q7 = **新表为唯一正本 + 同库事务双写**（方案见 docs/plans/member-迁移与共存.md）；Q3 = 余额 **JPY + Decimal(12,2)**（跨币种靠 `balance_currency` 隔离）；Q4 = 用户名 **UNIQUE**（前置查重已完成）
- [ ] **#3b 枚举反查**：**finance 部分已收口**——`dg_record.action` 全量 21 值 + 写入点（`finance-schema.md` §3.9）、`finance_order_cash_flow.change_type`（词表 `1 付款/2 退款`，实测全表皆 1、`addRefundLog()` 是死代码，§4.8）、`dg_rechargerecord.state/paytype`（§3.2）。**剩余**：`dg_users.utype`（`usetype` 注释已给 1代理購入/2転送/3無在庫/4OEM、`state` 待查）、`dg_record.action` 三个残余值的生产复核（`12` 会員費本地切片 0 行 / `13` 有 185 行却查不到写入点且 44% 链断 / `21` Stripe 写入点在 Python 侧），见 §八 Q7
- [x] **#3c member 迁移脚本**：Q4 查重**已完成**（8 组 / 16 账号，`docs/plans/02`）+ 消歧方案已拍板；T0 建表 DDL（`0001`）+ username collation（`0001a`）+ T1 回填（`0002`/`0004`）+ 一致性校验（`0003`/`0005`）全部就绪；**本地演练核心三表 15/15 PASS + 侧表 25/25 PASS、3 遍幂等、回退 OK**（`docs/plans/03`）
- [ ] **#3d ★ 生产写权限（T0/T1 阻塞项）**：生产账号 `datapro` 只有 `SELECT/INDEX/LOCK TABLES/SHOW VIEW`，**无 CREATE/INSERT/ALTER/DROP** → 需 DBA 用具备 DDL/DML 的账号执行 `0001 → 0001a → 0002 → 0003 → 0004 → 0005`。⚠ **2026-10-15 追加时序约束：先做完 #11b（金额精度 12,2→14,2、`balance_currency` JPY→CNY）并重生成 DDL，再让 DBA 落库**——否则生产建完就是错口径，回头是 ALTER + 三域回填重跑（现在改只是重生成脚本）。✅ #11b 已完成并复跑通过；✅ **#3g 已于 2026-10-16 空库全链跑绿**（`docs/plans/03` §十）⇒ **交 DBA 前只剩两条时序性前置**：① **T1 当天重跑 `precheck-username-duplicate.sql`**，把新重名组补进 `_t1_username_fix`（映射正本是 `0002` §1 的脚本字面量，「补」= 改字面量并走一次提交；脚本会 DROP+CREATE 重建该表，手工往表里插行会被下次执行抹掉）——不补就会被 `0002` 守卫拦停，**这是设计意图不是故障**；② **生产侧复跑新表名重名核查**（本机 dump 只覆盖 160/174 张，`deprecated_` 族本机为 0，见 #11c① / `finance-schema.md` §九-⑦）。T0 顺序：`0001 → 0001a → 0015 → 0002 → 0002a → 0003`（60 表）。⚠ **2026-10-16 策略转向（docs/04）：T0/T1 生产执行整体暂缓，转 R2（数据库重构期）启动，届时前置事项原样有效**。
- [x] **#3e 第二批侧表回填**：字段已按线上 `information_schema` 实测（122 列/13 表）→ `0004-member-backfill-t1-part2.sql`（13 表）+ `0005-member-backfill-verify-part2.sql`；**本地演练 25 项断言全 PASS、3 遍幂等**。要点：过滤外键孤儿（favorite 240 / browse 3389 / benefit 3 / log 68 / oauth_login 整表 1 行）、PAT 仅回填 `App\Models\User` 且父会员存在（105,808），保留源 id 并顶 AUTO_INCREMENT
- [ ] **#3f 双写 MemberRepository + 反向同步水位**（⚠ 2026-10-16 转 R2：R1 直接写旧表、无新表无双写，见 docs/04）
- [ ] **#4 契约基线**：把旧系统 GraphQL/REST 的关键接口在 `packages/contract` 定义成 TS 类型 + zod
- [ ] **#5 Tailwind + shadcn 接入**：web/mzk/admin 三个 app 接入 Tailwind 4 + shadcn/ui（`packages/ui` 的 token 与之对齐）
- [ ] **#6 ESLint/Prettier 全量接线**：eslint flat config 加入 next/react-hooks 插件，CI 门禁落地
- [ ] **#7 worker 真 Job 落地**：首个队列消费（幂等 upsert 模板）替代 ping 冒烟

### P2（阶段 1：member 垂直切片，第 2-3 个月）

- [ ] **#8 member 域端到端**：contract → route → service → repository → 单测跑通，与旧系统双跑对账
- [ ] **#9 会员认证**：Auth.js（NextAuth v5）+ JWT 落地，`dfFlag` 分流

### P3（阶段 2：核心域绞杀）

- [ ] **#10 order + send-order**（先补知识再动刀）：order 域 → `order-schema.md` + **Q5 已拍板** + schema 26 模型 + `0002`/`0002a` + `0006~0009` 回填**已落地并本地演练通过**（orders 73,291 / 组 26,078 / 砍价总额分毫不差 / 21 断言 PASS / 幂等）；send-order 域 → `send-order-schema.md` + **Q3 已拍板（发票归 send-order）**、七条未决问题收口（`06-send-order-评审与拍板.md`）+ schema 6 模型 + `0003` DDL + `0010~0013` 回填**已落地并本地演练通过**（send_orders 3,437 / invoices 29,238 / 五费总额分毫不差 / 18 断言 PASS / 幂等；顺带修复 order 域历史表 ODKU 翻倍坑）；**order/send-order 两域 contract 已完成**（`packages/contract/src/domains/order.ts` + `send-order.ts`：12 态/8 态/prostate 9 态词表 + 开放 API 建单/取消/支付/取消运单入参 + Query/Row/Create/迁移命令；15 项冒烟全过）；剩余：#11 finance + 对账体系 可启动
- [ ] **#11 finance + 对账体系**（ledger + 四方对账 + 钉钉告警）：知识底稿 `docs/plans/finance-schema.md`（4 表列级精读 + `action` 全量词表逆向 + 实测账本链断 **7.3% / 55% 会员** + 14 条建模决策 + Q1~Q14）。★ **Q1 已拍板（2026-10-15）：账本面值 = CNY**；**Q8 已拍板：金额 `Decimal(14,2)` / 汇率 `Decimal(12,8)`**。✅ **#11b 清扫完成后，finance 段 schema 已落地**（2026-10-15）：`schema.prisma` 12 模型（占位 `LedgerEntry` 整体替换）+ `0015-finance-domain-up.sql`（12 表，四段 DDL 重新基线：`0001` 16 表 / `0015` 12 / `0002` 26 / `0003` 6 = 60，`0002`/`0003` 重生成后逐字节不变）+ `pnpm db:generate` ✓ / `typecheck` 16/16 ✓；与草案的 6 处 delta 回写 §5.1。→ **剩余**：① `0016~0019` 回填脚本（★ 前置 #3g 已于 2026-10-16 跑绿，可以起跑）；② `contract/finance.ts` + `ledger.post()` 唯一写入口 + 对账 Job；③ Q3/Q5/Q6/Q9~Q14 未决。✅ 新表名重名核查与 `Account` 唯一键已收口，见 **#11c**。⚠ **2026-10-16 策略转向（docs/04）：R1 复现期 finance 纯平移（直接写旧表 `dg_record` 等），本项剩余工作（①②③、`0019` 后续、对账体系）全部转 R2/R3 启动；#11a 资金缺陷清单仍是 finance 域绞杀前的硬门槛**。
- [x] **#11b 口径清扫（CNY + `Decimal(14,2)`）**：✅ **完成**（代码/文档/DDL/复跑全绿）。`schema.prisma` 61 + 3 处金额列 → `(14,2)`、`exchange_rate`→`(12,8)`、`balance_currency`/`charged_currency` 默认值与**回填脚本 3 处硬写 `'JPY'` 字面量**（`0002:95`/`0002:166`/`0007:248`）→ CNY、22 处「JPY（旧…）」注释、四份计划书 + `docs/07 §6.2` + `utils/money.ts` + `AGENTS.md` 改判记录；`0001/0002/0003` 重生成。**复跑证据**（`docs/plans/03` §九）：重建 49 表后全链两遍计数金额不变——Σbalance = Σ`dg_users.money` = **115,263,758.22**、Σ砍价 **364,598.62**、五费 **3,050,486.56**、历史表行数=实体数、非 CNY 行 **0**、侧表 24/24 PASS。★ 有意保留非 14,2：`float_rate`（Q3 死列）、`invoices.order_weight`、`invoices.low_multiple`（非金额）、`shops.currency='JPY'`（外部平台自身结算币种）。**复跑另挖出一个会吞账号的 ODKU 缺陷 → 已加 fail-fast 守卫，见 #3g**
- [x] **#3g member 回填硬化（T1 前置，复跑暴露的四条）**：✅ **2026-10-16 空库 `crossbuy_t1v` 全链复跑通过**，证据见 `docs/plans/03-T1本地演练报告.md` **§十**。①★ `0002` ODKU 会静默吞账号 + 改余额（本地实测吞 5 个账号、清零 2 笔余额且零报错）→ 守卫 `_guard_username_disambiguated` 按 `utf8mb4_general_ci` 判碰撞即 SIGNAL 中止、**报错点名撞车用户名**；实弹验证两种破坏手法（生产映射跑本地快照 / 删一条映射行）都 `rc=1` 拦停在 §2 之前。② 映射升实体暂存表 `_t1_username_fix`/`_t1_username_merge` ⇒ `0003` 重写为 21 项、**期望值全部按当前源实时计算**（新增 A3 陈旧 / A4 规则 / A5 悬空 / B14 落库核对；快照数字降为 INFO）→ 实测 17 PASS + 4 INFO + 0 FAIL。③ `member_address` 补 `JOIN member` 过滤孤儿 → 实测 2,147 行 / 悬空 0 / 过滤 7,324。④ 新增 `0014-member-source-import.sql`（15 表）+ `0006` §0 自愈化 → 空库首跑 rc=0。**复跑中另抓到并修掉三个坑**：本机 `taotaro` 缺 4 张 member 侧表（改逐表择优取源）、`ROW_COUNT()` 在 `DEALLOCATE` 后采集被重置成 0（审计一度全报 0 行）、`0014` 会在源库里 DROP 目标表（加安全守卫）。
- [x] **#11c finance 段落地的两项收口（2026-10-16，用户授权自行判断）**：① **重名核查**——12 张 finance 表名在本机 `taotaro`（160 张）命中 **0**，连单数 `ledger_entry` 都不存在，13 张无前缀旧表也不撞 ⇒ **表名不改**；⚠ 本机 dump 比 `docs/plans/00` 记的 174 张少 14 张（`deprecated_` 族本机为 0）⇒ **生产 T0 前 DBA 仍要复跑同一条 `information_schema` 查询**（SQL 在 `finance-schema.md` §九-⑦）。② **`Account` 唯一键**：`member_id` 由 NULL 改 **sentinel 0** + 唯一键升 `@@unique(kind, currency, member_id)`（依据：`member.id` 恒 ≥ 1，0 不可能撞真实会员）；功能实测重复 `(COMPANY,CNY,0)` → `ERROR 1062` 拦住、`(COMPANY,JPY,0)` 可插（保留多币种）；重生成后 `0001`/`0002`/`0003` 三份 DDL **git 无变化**（零漂移）、`pnpm typecheck` 16/16 ✓

- [ ] **#11a 旧系统资金安全缺陷清单（切写前每条要有对策，对策落 `finance-schema.md` §4.3/§4.4/§4.7）**：PayPal 回调幂等仅 `Cache::lock(2s)` + 先查后改无唯一键（重复加钱）、`dg_rechargerecord` 后台可改 `money`/`state`/汇率反算且不补流水、`dg_huilv` 汇率全字段可手改、人工调整走 `dg_record.action=0` 自由文本无原因码、**充值「初审通过即入账」（银行流水核对在后，敞口未量化，见 finance-schema §4.7/Q14）**、月费与仓储费两个 Job 无锁无校验可扣成负数
  ★ **2026-10-16 新增第 7 条**：`dg_rechargerecord.currency` 实测有 `jpy` / `MYR` / `NULL` 三种，而 **MYR 段的 `Σmoney/Σamount` = 0.0458 与日元段的 0.0459 几乎相同**（1 MYR ≈ 1.5 CNY，差 30 倍以上）⇒ 旧系统对马币入金**大概率直接套了日元汇率**，属实际少收/多收的资金口径缺陷。回填不修数据：`rate_source='LEGACY_DERIVED'` 原样落库 + 登记 `reconciliation_diffs(RATE_DRIFT, 701 行)`，新系统 `ledger.post()` 必须按 `(source_currency → CNY)` 取当日汇率、**禁止沿用单据上的旧比率**。
- [x] **#11d finance 段 T1 回填脚本 `0016~0018`（2026-10-16 本机演练跑绿）**：`0016` 搬 5 张旧源 3,781,204 行（62s）→ `0017` 建 **994,279 条分录** + 5,026 户 + 6,475 入金单 + 55,732 条汇率 + 16 条历史缺陷基线 → `0018` **31 项断言 29 PASS / 0 FAIL / 2 INFO**；两遍计数与 Σ金额**逐字全等**；删掉一条 `flow_type` 映射后 F1=342 行立刻 FAIL（词表漏值不静默归类）。★ 演练顺带抓出 **10 个真缺陷**并逐条修（证据 `docs/plans/03` §十一）。原计划 `0019` 取消：单据与汇率必须和分录在同一序列里跑，否则基线断言拿不到完整分录集。
- [ ] **#11e finance 回填的生产侧收口（本机测不出来，交 DBA 前必做）**：① 全量 `GROUP BY action` 验 Q7 三个残余值（12 月费 / 21 Stripe / OEM 17·22·23）；② `dg_record.idempotency_key` 与 `gateway_transaction_no` 非 NULL 率；③ 全量链断率（本机切片口径 7.29%，member 过滤后 12,081 处）；④ H1/H2 两条 INFO 在生产转**硬判据**；⑤ `dg_record_old` 确认仍停写（§八 Q2 按不并处置——✅ 2026-10-16 生产实测存在且 **5,924,645 行**，停写与否仍待验）；⑥ ~~`v2_worldfirst_*` 存在性（Q13）~~ **✅ 已解（2026-10-16 生产实测）：五表真实存在但全部 0 行**——「唯一真对账实现」是空壳死表，R2/R3 对账从零建无历史包袱（详见 `docs/plans/07` §三）。⚠ 另加一条纪律：**同一库同一时刻只允许一个 `0017` 实例**（§1 重建 `_t1_*` 暂存表，并发会假报 `ER_NO_SUCH_TABLE`）。
- [ ] **#11f 旧代码逆向补读**：OEM 专属 `action` 14–20/22/23 的业务语义需读 `haiou/app/Models/Record.php:100-110`（`resolveOemAction()` 按 paytype 映射）——本轮 flow_type 先落 `OEM_SERVICE_FEE_{n}` 占位，本机合计仅 11 行，语义不阻塞建表但阻塞对账口径。
- [ ] **#12 logistics / ticket / cms**
- [ ] **#13 前台 www 灰度替换**（SEO 收录不能断）

## 二、红线与坑（写代码前必读，每条带失败案例）

- **金额浮点**：JS 直接 `+ - * /` 算钱会产生 `0.1+0.2=0.30000000000000004`。→ 一律 `utils/money` 单入口。
- **先查后改丢更新**：并发下 check-then-act 会超卖/透支。→ 守卫下到原子 UPDATE 的 WHERE。
- **先查后插撞唯一键**：拉单/同步并发重跑会撞 uk 报错。→ 唯一键 upsert（Prisma `upsert`），幂等。
- **★ ODKU 用错实体边界（2026-10-15 演练实锤）**：`INSERT..ON DUPLICATE KEY UPDATE` 的前提是「撞键 = 同一实体重复投递」。若唯一键是**业务属性**（如 `member.username`），撞键意味着**两个不同实体**，ODKU 会把后者的整行静默盖到前者身上——本地实测吞掉 5 个账号、把 2 笔余额清零（100.18/19.96），**零报错**。→ 这类键必须 **fail-fast 中止**（守卫 `SIGNAL`），禁 upsert 覆盖；且唯一性判断要按**目标列 collation**（`utf8mb3_general_ci` 折叠假名、`utf8mb4_general_ci` 不折叠）。
- **事务内调外部 API**：外部慢/挂把本地事务拖死。→ AFTER_COMMIT 或事件后再外呼，失败只记日志可补。
- **契约出现 ORM 类型**：等于没隔离，前后端又被耦合。→ contract 包只依赖 zod。
- **状态机「先查后改」**：查时待审核，改时别人已通过。→ `WHERE status=from` 条件更新。
- **★ 「结构跑通、数字全零」也是假绿（2026-10-16 复跑实锤）**：`0014` 的搬运审计一度 15 张表全报 `source_rows=0`，看着像「导入成功但源表是空的」，实际是 `ROW_COUNT()` 被后面的 `DEALLOCATE PREPARE` 重置——采集点必须**紧跟 `EXECUTE`**。同族错误：`2>/dev/null` 把 `ERROR 2003 Can't connect` 吞成「查到 0 行」。⇒ 任何「0 / 空 / 无结果」都要用第二个独立来源交叉核对（本轮用 `COUNT(*)` 直查目标表才暴露），否则校验脚本自己就会成为假绿的来源。
- **裸 TODO**：AI 留的 TODO 没编号没登记，人工不知道哪些要补。→ `TODO(编号)` + 登记本清单。
- **改旧系统**：haiou 生产运行中，顺手改 = 生产事故。→ 只读，绝不写。
