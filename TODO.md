# TODO.md — 待办 + 红线与坑

> 约定：清单只装**未完成**项；完成即删除（全文在 git 历史可溯），不打勾留着。
> 编号不复用、不重排。代码里的 `TODO(编号)` 与本清单一一对应。

## 一、待办（P0 → P3）

### P0（本月，最紧急）

- [ ] **#1 山景私有包续命**：fork 6 个 `shanjing/*` 包到公司自有 Git + 自建 composer 私有源（见 docs/03 §1.1）
- [ ] **#2 知识盘点**：趁兼职张在，产出 Finance/Order 域业务规则清单 + 外部对接坑 + 对账缺失现状（docs/03 §1.2）

### P1（阶段 0：基建，第 1 个月）

- [x] **#3 旧库表结构反推**：完成 174 张表盘点（docs/plans/00）+ v2_ 44 张与 finance 流水字段级精读（docs/plans/01）+ member 域 schema 草案（docs/plans/member-schema.md + schema.prisma 17 模型）
- [x] **#3a 关键决策已定**：Q7 = **新表为唯一正本 + 同库事务双写**（方案见 docs/plans/member-迁移与共存.md）；Q3 = 余额 **JPY + Decimal(12,2)**（跨币种靠 `balance_currency` 隔离）；Q4 = 用户名 **UNIQUE**（前置查重已完成）
- [ ] **#3b 枚举反查**：**finance 部分已收口**——`dg_record.action` 全量 21 值 + 写入点（`finance-schema.md` §3.9）、`finance_order_cash_flow.change_type`（词表 `1 付款/2 退款`，实测全表皆 1、`addRefundLog()` 是死代码，§4.8）、`dg_rechargerecord.state/paytype`（§3.2）。**剩余**：`dg_users.utype`（`usetype` 注释已给 1代理購入/2転送/3無在庫/4OEM、`state` 待查）、`dg_record.action` 三个残余值的生产复核（`12` 会員費本地切片 0 行 / `13` 有 185 行却查不到写入点且 44% 链断 / `21` Stripe 写入点在 Python 侧），见 §八 Q7
- [x] **#3c member 迁移脚本**：Q4 查重**已完成**（8 组 / 16 账号，`docs/plans/02`）+ 消歧方案已拍板；T0 建表 DDL（`0001`）+ username collation（`0001a`）+ T1 回填（`0002`/`0004`）+ 一致性校验（`0003`/`0005`）全部就绪；**本地演练核心三表 15/15 PASS + 侧表 25/25 PASS、3 遍幂等、回退 OK**（`docs/plans/03`）
- [ ] **#3d ★ 生产写权限（T0/T1 阻塞项）**：生产账号 `datapro` 只有 `SELECT/INDEX/LOCK TABLES/SHOW VIEW`，**无 CREATE/INSERT/ALTER/DROP** → 需 DBA 用具备 DDL/DML 的账号执行 `0001 → 0001a → 0002 → 0003 → 0004 → 0005`。⚠ **2026-10-15 追加时序约束：先做完 #11b（金额精度 12,2→14,2、`balance_currency` JPY→CNY）并重生成 DDL，再让 DBA 落库**——否则生产建完就是错口径，回头是 ALTER + 三域回填重跑（现在改只是重生成脚本）。✅ #11b 已完成并复跑通过 ⇒ **当前前置是 #3g 的收尾两件事**：① 新版 `0002`/`0003`/`0014` **还没跑过一次**，先在演练库按 README 四步判定跑绿；② **T1 当天重跑 `precheck-username-duplicate.sql`**，把新重名组补进 `_t1_username_fix`（映射已升为实体暂存表，脚本 §1 会 DROP+CREATE 重建，所以「补」= 改 `0002` §1 的字面量并走一次提交）。缺任一步，`0002` 的守卫会直接中止——**这是设计意图，不是故障**。
- [x] **#3e 第二批侧表回填**：字段已按线上 `information_schema` 实测（122 列/13 表）→ `0004-member-backfill-t1-part2.sql`（13 表）+ `0005-member-backfill-verify-part2.sql`；**本地演练 25 项断言全 PASS、3 遍幂等**。要点：过滤外键孤儿（favorite 240 / browse 3389 / benefit 3 / log 68 / oauth_login 整表 1 行）、PAT 仅回填 `App\Models\User` 且父会员存在（105,808），保留源 id 并顶 AUTO_INCREMENT
- [ ] **#3f 双写 MemberRepository + 反向同步水位**（T1 运行期）
- [ ] **#4 契约基线**：把旧系统 GraphQL/REST 的关键接口在 `packages/contract` 定义成 TS 类型 + zod
- [ ] **#5 Tailwind + shadcn 接入**：web/mzk/admin 三个 app 接入 Tailwind 4 + shadcn/ui（`packages/ui` 的 token 与之对齐）
- [ ] **#6 ESLint/Prettier 全量接线**：eslint flat config 加入 next/react-hooks 插件，CI 门禁落地
- [ ] **#7 worker 真 Job 落地**：首个队列消费（幂等 upsert 模板）替代 ping 冒烟

### P2（阶段 1：member 垂直切片，第 2-3 个月）

- [ ] **#8 member 域端到端**：contract → route → service → repository → 单测跑通，与旧系统双跑对账
- [ ] **#9 会员认证**：Auth.js（NextAuth v5）+ JWT 落地，`dfFlag` 分流

### P3（阶段 2：核心域绞杀）

- [ ] **#10 order + send-order**（先补知识再动刀）：order 域 → `order-schema.md` + **Q5 已拍板** + schema 26 模型 + `0002`/`0002a` + `0006~0009` 回填**已落地并本地演练通过**（orders 73,291 / 组 26,078 / 砍价总额分毫不差 / 21 断言 PASS / 幂等）；send-order 域 → `send-order-schema.md` + **Q3 已拍板（发票归 send-order）**、七条未决问题收口（`06-send-order-评审与拍板.md`）+ schema 6 模型 + `0003` DDL + `0010~0013` 回填**已落地并本地演练通过**（send_orders 3,437 / invoices 29,238 / 五费总额分毫不差 / 18 断言 PASS / 幂等；顺带修复 order 域历史表 ODKU 翻倍坑）；**order/send-order 两域 contract 已完成**（`packages/contract/src/domains/order.ts` + `send-order.ts`：12 态/8 态/prostate 9 态词表 + 开放 API 建单/取消/支付/取消运单入参 + Query/Row/Create/迁移命令；15 项冒烟全过）；剩余：#11 finance + 对账体系 可启动
- [ ] **#11 finance + 对账体系**（ledger + 四方对账 + 钉钉告警）：知识底稿 `docs/plans/finance-schema.md`（4 表列级精读 + `action` 全量词表逆向 + 实测账本链断 **7.3% / 55% 会员** + 14 条建模决策 + Q1~Q14）。★ **Q1 已拍板（2026-10-15）：账本面值 = CNY**；**Q8 已拍板：金额 `Decimal(14,2)` / 汇率 `Decimal(12,8)`**。✅ **#11b 清扫完成后，finance 段 schema 已落地**（2026-10-15）：`schema.prisma` 12 模型（占位 `LedgerEntry` 整体替换）+ `0015-finance-domain-up.sql`（12 表，四段 DDL 重新基线：`0001` 16 表 / `0015` 12 / `0002` 26 / `0003` 6 = 60，`0002`/`0003` 重生成后逐字节不变）+ `pnpm db:generate` ✓ / `typecheck` 16/16 ✓；与草案的 6 处 delta 回写 §5.1。→ **剩余**：① `0016~0019` 回填脚本（前置 #3g 复跑先跑绿）；② 新表名重名核查（见 #11c）；③ `contract/finance.ts` + `ledger.post()` 唯一写入口 + 对账 Job；④ Q3/Q5/Q6/Q9~Q14 未决。
- [ ] **#11c finance 段落地后新暴露的两件事**：① ★ **12 张 finance 表是本项目首批「无前缀」表名，重名从未核查过**——`docs/plans/00` 只按 `dg_`/`v2_`/`admin_`/`sys_`/`deprecated_`/`relation_` 六个前缀盘点，前三域新表都带域前缀所以天然没撞（`accounts` 风险最高）→ T0 落库前必须跑 `finance-schema.md` §九-⑦ 的 `information_schema` 查询；② `Account` 的 `@@unique(kind, memberId)` 在 `memberId IS NULL`（COMPANY/PURCHASE/FREIGHT/…）时**不去重**（MySQL 唯一索引里 NULL 互不相等）→ 需拍板收口方式：sentinel `0` / `@@unique(kind, currency)` / 只靠应用层单写者。本轮**未擅自改语义**，保持草案原样并在模型注释里标记。
- [x] **#11b 口径清扫（CNY + `Decimal(14,2)`）**：✅ **完成**（代码/文档/DDL/复跑全绿）。`schema.prisma` 61 + 3 处金额列 → `(14,2)`、`exchange_rate`→`(12,8)`、`balance_currency`/`charged_currency` 默认值与**回填脚本 3 处硬写 `'JPY'` 字面量**（`0002:95`/`0002:166`/`0007:248`）→ CNY、22 处「JPY（旧…）」注释、四份计划书 + `docs/07 §6.2` + `utils/money.ts` + `AGENTS.md` 改判记录；`0001/0002/0003` 重生成。**复跑证据**（`docs/plans/03` §九）：重建 49 表后全链两遍计数金额不变——Σbalance = Σ`dg_users.money` = **115,263,758.22**、Σ砍价 **364,598.62**、五费 **3,050,486.56**、历史表行数=实体数、非 CNY 行 **0**、侧表 24/24 PASS。★ 有意保留非 14,2：`float_rate`（Q3 死列）、`invoices.order_weight`、`invoices.low_multiple`（非金额）、`shops.currency='JPY'`（外部平台自身结算币种）。**复跑另挖出一个会吞账号的 ODKU 缺陷 → 已加 fail-fast 守卫，见 #3g**
- [ ] **#3g member 回填硬化（T1 前置，复跑暴露）**：①★ **`0002` ODKU 会静默吞账号 + 改余额**——未进映射的重名对第二行撞车后把前一个账号整行覆盖（本地实测吞 5 个账号、清零 2 个余额 100.18/19.96，零报错）；守卫 `_guard_username_disambiguated` 按 `utf8mb4_general_ci` 判碰撞即 SIGNAL 中止，**报错文本现附撞车名**。②③④ **已静态落地（2026-10-15）**：映射升为实体暂存表 `_t1_username_fix`/`_t1_username_merge` ⇒ `0003` 重写为 **21 项、期望值全部按当前源实时计算**（新增 A3 映射陈旧 / A4 改名规则 / A5 合并悬空 / B14 落库核对；快照数字降为 A1/A1b/A1c INFO 永不 FAIL）；`member_address` §4 加 `JOIN member` 过滤孤儿（B12 升硬 PASS + B13 INFO）；新增 **`0014-member-source-import.sql`**（15 张旧源表 + 行数自检），`0006` §0 自愈化。**★ 剩余唯一未闭环：新版脚本一次都没跑过**（本机 FlyEnv 口令不入仓库/对话）→ 按 `packages/db/sql/README.md`「复跑验证命令」四步判定：空库全链全 PASS、两遍幂等、**故意删映射行验证守卫真能拦**、`0014` 逐表行数相等。跑绿前 **#3d 不算可交付**。
- [ ] **#11a 旧系统资金安全缺陷（须在切写前封堵）**：PayPal 回调幂等仅 `Cache::lock(2s)` + 先查后改无唯一键（重复加钱）、`dg_rechargerecord` 后台可改 `money`/`state`/汇率反算且不补流水、`dg_huilv` 汇率全字段可手改、人工调整走 `dg_record.action=0` 自由文本无原因码、**充值「初审通过即入账」（银行流水核对在后，敞口未量化，见 finance-schema §4.7/Q14）**、月费与仓储费两个 Job 无锁无校验可扣成负数
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
- **裸 TODO**：AI 留的 TODO 没编号没登记，人工不知道哪些要补。→ `TODO(编号)` + 登记本清单。
- **改旧系统**：haiou 生产运行中，顺手改 = 生产事故。→ 只读，绝不写。
