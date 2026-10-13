# 项目长期记忆 — crossbuy（淘太郎平台重写）

## crossbuy 是什么
面向**日本市场**的**中国商品代购平台**（`yiwutaro.com`）的全栈重写项目，位于 `D:/Work/project/own/crossbuy`。
是对旧系统（`haiou`）技术栈与架构的**系统性重做**，不是原地重构。

## 原项目（唯一参考来源，只读）
- **位置**：`D:/Work/project/haiou/`（绝对路径，过渡期内持续生产运行）
- 三个仓库：`backend`（Laravel 12 + dcat-admin + GraphQL/REST）、`frontend`（Astro 5 + Deno + Vue3 + React19，PC 前台 www）、`mzk-frontend`（代发端 mzk）
- **读取纪律**：原项目是「参考源」不是「修改对象」。读它的业务逻辑/数据模型/接口契约，**绝不修改、不提交**。过渡期两套共用同一 MySQL。
- 权威地图见 `docs/00-原项目参考指南.md`（精确路径 + 关键文件清单）。

## 技术栈定稿（2026-10-12，多轮收敛）
- **全 TypeScript**：Next.js 全栈（App Router）+ Tailwind + shadcn/ui
- 后台重活（58 Job/队列/webhook/定时/批处理）→ 独立 **TS Worker（BullMQ + Redis）**
- 数据库 MySQL 8 + **Prisma**；仓库 **Monorepo**（pnpm workspace + Turborepo）
- 结构：`apps/{web,mzk,admin,worker}` + `packages/{ui,db,contract,config,auth,utils}`
- **WMS = 独立项目**（未来 `own/wms` 从零写；现有 WMS 在外包手里无代码）。主系统只留 `wms-gateway` 接口面。
- 明确排除：若依（定制层 AI 不熟+双语言）、NestJS（尴尬中间态）、Java/Spring（选了全 TS）、Deno/Astro/Vue（旧系统冷门割裂栈）

## 选型理由（为什么全 TS）
单语言 + 强类型对「AI 写代码」最友好；Next/React/Tailwind/shadcn 是 AI 语料最丰富组合；`contract` 包单点定义 API 契约（编译期杜绝前后端不一致、杜绝「改金额参数」类漏洞）。

## 迁移铁律（红线）
1. **禁 Big Bang**：新旧必须能并行，旧系统可随时回退
2. **按域垂直切片**：一个域「前后端+worker+契约」端到端跑通再切
3. **数据共库**：过渡期共用同一 MySQL，禁双写不同库
4. **金额不可信**：新系统金额一律服务端重算 + Decimal + ledger 账本 + 四方对账
5. **webhook/队列消费幂等**（1688 会重复投递）

## 迁移顺序（价值 × 知识沉淀）
先续命（fork 山景私有包 + 兼职张知识盘点）→ member 开放 API 试水（文档最全）→ order/send-order → finance（含对账）→ logistics/ticket/cms。前台 www 灰度替换（SEO 不能断收录）。

## 从旧系统继承的关键结论（重写时必须规避的坑）
- **领域模型硬伤**（AGENTS.md 自曝）：`bargainprice` 在 Order/SendOrder 语义不同；`goodsprice` vs `goodsprice1`（原价/砍后价）；各域 `status` 独立状态机不可跨域假设
- **对账体系缺失**：旧 `app/` 里 `对账/reconcile` 0 命中，有流水无对账；后门 `skip_price_check`、后台 `BatchUpdateOrder` 可改金额且无兜底 → 新系统必须内置对账
- **山景私有包无主**：6 个 `shanjing/*` 包分发渠道全在山景手里，`vendor/` 未入 git，`laravel-admin`(2634 文件) 是后台骨架 → 重写前必须 fork 续命（详见 `haiou/.workbuddy/memory/2026-10-12.md`）
- 领域边界（AGENTS.md）：Order · SendOrder · Finance · Logistics · Member/User · WMS · Ticket · Email

## 关键约定
- `own/` 下的 `agent`、`ec-erp`、`system-kit` 是用户**个人项目，勿动**
- 业务文档 80 篇在 `backend/docs/business/`；架构分层规则在 `backend/AGENTS.md`
- 团队：2-3 名 Java 背景正式员工接管，兼职张（当前主力）将离开 → 知识盘点是重写前置条件
