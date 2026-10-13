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
- [ ] **#3b 枚举反查**：从旧代码反查 `dg_users.utype/usetype/state`、`finance_order_cash_flow.change_type` 的完整枚举（member-schema.md Q1/Q2）
- [x] **#3c member 迁移脚本**：Q4 查重**已完成**（8 组 / 16 账号，`docs/plans/02`）+ 消歧方案已拍板；T0 建表 DDL（`0001`）+ username collation（`0001a`）+ T1 回填（`0002`/`0004`）+ 一致性校验（`0003`/`0005`）全部就绪；**本地演练核心三表 15/15 PASS + 侧表 25/25 PASS、3 遍幂等、回退 OK**（`docs/plans/03`）
- [ ] **#3d ★ 生产写权限（T0/T1 阻塞项）**：生产账号 `datapro` 只有 `SELECT/INDEX/LOCK TABLES/SHOW VIEW`，**无 CREATE/INSERT/ALTER/DROP** → 需 DBA 用具备 DDL/DML 的账号执行 `0001 → 0001a → 0002 → 0003 → 0004 → 0005`
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

- [ ] **#10 order + send-order**（先补知识再动刀）
- [ ] **#11 finance + 对账体系**（ledger + 四方对账 + 钉钉告警）
- [ ] **#12 logistics / ticket / cms**
- [ ] **#13 前台 www 灰度替换**（SEO 收录不能断）

## 二、红线与坑（写代码前必读，每条带失败案例）

- **金额浮点**：JS 直接 `+ - * /` 算钱会产生 `0.1+0.2=0.30000000000000004`。→ 一律 `utils/money` 单入口。
- **先查后改丢更新**：并发下 check-then-act 会超卖/透支。→ 守卫下到原子 UPDATE 的 WHERE。
- **先查后插撞唯一键**：拉单/同步并发重跑会撞 uk 报错。→ 唯一键 upsert（Prisma `upsert`），幂等。
- **事务内调外部 API**：外部慢/挂把本地事务拖死。→ AFTER_COMMIT 或事件后再外呼，失败只记日志可补。
- **契约出现 ORM 类型**：等于没隔离，前后端又被耦合。→ contract 包只依赖 zod。
- **状态机「先查后改」**：查时待审核，改时别人已通过。→ `WHERE status=from` 条件更新。
- **裸 TODO**：AI 留的 TODO 没编号没登记，人工不知道哪些要补。→ `TODO(编号)` + 登记本清单。
- **改旧系统**：haiou 生产运行中，顺手改 = 生产事故。→ 只读，绝不写。
