# TODO.md — 待办 + 红线与坑

> 约定：清单只装**未完成**项；完成即删除（全文在 git 历史可溯），不打勾留着。
> 编号不复用、不重排。代码里的 `TODO(编号)` 与本清单一一对应。

## 一、待办（P0 → P3）

### P0（本月，最紧急）

- [ ] **#1 山景私有包续命**：fork 6 个 `shanjing/*` 包到公司自有 Git + 自建 composer 私有源（见 docs/03 §1.1）
- [ ] **#2 知识盘点**：趁兼职张在，产出 Finance/Order 域业务规则清单 + 外部对接坑 + 对账缺失现状（docs/03 §1.2）

### P1（阶段 0：基建，第 1 个月）

- [ ] **#3 旧库表结构反推**：已拿到 `taotaro.sql`（174 张表结构）并完成盘点（见 docs/plans/00），下一步精读 v2_ 44 张 + finance 流水，产出 Prisma schema 草案
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
