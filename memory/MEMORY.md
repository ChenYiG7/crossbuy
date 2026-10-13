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

## 表重构与共存策略（2026-10-13 定，Q7）
- **新表为唯一正本**：重写**不继承旧表结构**（弃 MD5 无盐密码、`money` 挂用户、`float` 存金额、INT unix 时间戳、Laravel 多态外键、各域 status 混用）。
- **过渡期共存 = 同库同事务双写**：新系统写 `member_*` + 旧表（`dg_users`/`dg_address`/`v2_*`）在**同一个 MySQL 的同一个事务**内 upsert；读只读新表。铁律 3「禁双写**不同库**」针对跨库（无法原子），**同库双表不在此列**。
- **主键对齐**：`member.id == dg_users.uid`（回填显式带 id + 顶 AUTO_INCREMENT），保跨域 JOIN 与旧系统一致。
- **切换时序**：T0 建新表 → T1 回填+读新写双 → T2 切写入口（旧写归零）→ T3 旧表降级只读投影（供未切换域 JOIN），随域退休。
- 详见 `docs/plans/member-迁移与共存.md`；member 设计见 `docs/plans/member-schema.md`。
- **已定参数（2026-10-13）**：余额 = **JPY + `Decimal(12,2)`**，跨币种靠 `balance_currency` 隔离、禁跨币种直接加减；`username` 上 **UNIQUE**。
- **Q4 查重已跑（2026-10-13，旧库只读）**：22,611 用户中 **8 组 / 16 账号**重名；除 uid 4109（¥291.02/107 单）外全零订单。明细与消歧见 `docs/plans/02-用户名重名处置.md`，复现见 `packages/db/sql/disambiguate-username-proposal.sql`。
- **Collation 坑（重要）**：旧库 `utf8_general_ci`（ci + **尾空格不敏感**），新表 `utf8mb4_unicode_ci` 同为 ci → 撞车口径一致；前导空格 ci 下有效但新表 TRIM 后仍撞。判尾空格**禁用** `uname = TRIM(uname)`（ci 下 `'a '='a'` 真），必须比 `CHAR_LENGTH`。`member.username` 的 collation 需显式定（**Prisma 不原生支持列级 collation，需 raw SQL ALTER**）；email **不加唯一**（`123456@qq.com` ×31 为测试号）。
- **生产库只读通道**：跳板机 `114.215.206.28` + SSH 端口转发 → PolarDB `taotaro`；本机 PHP CLI（FlyEnv 8.4）作 PDO 客户端。密码不入代码/文档，放独立文件。
- **列名约定**：一律 snake_case。Prisma 默认用字段名当列名 → **每个多词字段必须 `@map("snake_case")`**（否则生成 camelCase 列）。
- **T0 建表 DDL** 由 `schema.prisma` 生成：`prisma migrate diff --from-empty --to-schema-datamodel ... --script > packages/db/sql/0001-member-domain-up.sql`（17 表，无外键）。改 schema 后必须重生成，**禁手改 DDL**。

## 数据模型参考（docs/plans）
- `00-旧库表结构盘点.md`：174 张旧表按代际分组（dg_ 71 / v2_ 44 / deprecated_ 21 / admin_ 12 / sys_ 11 / 其他）
- `01-v2表字段精读.md`：44 张 v2_ + `finance_order_cash_flow` 字段级精读（唯一键/状态枚举/坑）
- 关键发现：`v2_address`/`v2_area` 是**行政区划字典**（非收货地址）；会员主表是 `dg_users`（v2_ 无会员主表）；`finance_order_cash_flow` 是会员现金流水（非订单行）
- 金额精度不统一（DECIMAL(10,2)/(12,2)/float/varchar「价格+币种」）；`v2_order_detail.coupon_fee` 是 float

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
