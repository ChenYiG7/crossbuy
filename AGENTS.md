# AGENTS.md — crossbuy 项目宪法（AI 会话入口）

> 本文档是每个 AI 会话冷启动的「必装上下文」。磁盘是唯一可信状态，聊天记录不是。

## 信息源优先级（冲突时按此裁决）

`本文件 > docs/04 重写架构方案（2026-10-16 起总纲） > docs/07 开发规范守则 > TODO.md > docs/01~03、06 > packages/*/源码注释 > 代码`

## 必读区（做某类事前必读）

| 要做的事 | 先读 |
|---|---|
| 接手任何任务 | 本文件 + `TODO.md`（红线与坑） |
| 规划整体架构 / 分期 / 迁移与数据策略 | **`docs/04-重写架构方案.md`（现行总纲，03/06 与其冲突处以 04 为准）** |
| 写任何代码 | `docs/07-开发规范守则.md`（唯一写入口/幂等/金额/状态机/防腐层） |
| 设计表结构 | `docs/07` §schema 规约 + `packages/db/prisma/redesign/schema.prisma`（R2 新表正本）；R1 复现期旧表结构看 `packages/db/prisma/schema.prisma`（introspect 产物） |
| 参考旧系统业务 | `docs/00-原项目参考指南.md`（旧系统在哪、怎么读、雷区） |
| 规划一个域 / 排里程碑 | `docs/06-开发计划.md`（R1 执行版：M0~M5 + 域绞杀 DoD + 常设纪律 + prompts） |

## 技能（`.workbuddy/skills/`，2026-10-17 自 Claude Code superpowers 生态引入）

共 6 个，**命中场景必须先加载再动手**：

| 场景 | 加载 |
|---|---|
| 即将声称「完成/修好了/通过」、提交或推送前 | `verification-before-completion` |
| 任何 bug / 测试失败 / 意外行为（**提修复方案前**） | `systematic-debugging` |
| 写手写业务规则（金额 / 状态机 cas / 幂等 upsert / 账本）前 | `test-driven-development` |
| 写一个多步任务的实现计划 | `writing-plans`（执行时 `executing-plans`） |
| 收尾：验证通过后的合并 / PR / 清理 | `finishing-a-development-branch` |

- 引入与同步：`node scripts/import-claude-skills.mjs`（上游 `~/.claude/skills/` 更新后重跑即可）。
- ★ **项目专属补丁的正本在该脚本的 `PROJECT_PATCHES`**（如 TDD 的「生成器优先 vs TDD 只约束
  手写业务规则」边界）。**不要直接改 `.workbuddy/skills/` 下的文件**——下次重跑会被整目录覆写冲掉。
- 目录位置固定在 `.workbuddy/skills/`（工具链路径，**不可为躲 .gitignore 而搬家**）；
  `.gitignore` 整体忽略 `.workbuddy/` 但放行 `skills/` 与 `memory/`，详见 README §仓库卫生。
- 与 `docs/07` 冲突时以 docs/07 为准。
- ⚠ 本环境的技能列表来自插件缓存，项目级技能**需重启会话**才会出现在可调用列表；列表里
  刷不出来时，按上表直接读对应 `SKILL.md` 文件，效力相同。

## 项目是什么

面向**日本市场**的**中国商品代购平台**（`yiwutaro.com`）的全栈重写。原系统 `D:/Work/project/haiou/`（Laravel + Astro/Deno）生产运行中，**只读参考，绝不修改**。过渡期新旧共用同一 MySQL。

**现行总纲（2026-10-16 定，`docs/04`）**：R1 = 功能复现——**数据库不动**（直接读写旧表），旧系统三个项目（backend/frontend/mzk-frontend）一起用全 TS 重做，GraphQL→REST，按域绞杀 PHP；60 模型新表方案封存为 R2 资产；R3 = 认证中心 + 系统拆分（模块边界现在按拆分形态设计）。

## 技术栈定版表（定版 2026-10-12）

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 语言 | TypeScript | ^5.6 | 全仓唯一语言，`strict: true` |
| 前端 | Next.js App Router | ^15.1 | 三个 app（web/mzk/admin） |
| 样式 | Tailwind + shadcn/ui | （待接入） | 骨架阶段尚未接线，phase 1 做 |
| ORM | Prisma | ^6.2 | MySQL 8，`packages/db` |
| 队列 | BullMQ + Redis | ^5.34 | `apps/worker`，替代 58 个 Job |
| 构建 | pnpm + Turborepo | pnpm 9 / turbo 2 | monorepo |
| 校验 | zod | ^3.24 | 契约 + 服务端校验共用 |
| 机器面 API | Fastify + zod（**apps/api，2026-10-16 新增**） | ^5.x | 只承载 open API + webhook（签名/IP 白名单）；见 docs/04 §2 |
| 金额 | decimal.js（`utils` 单入口） | ^10.4 | 禁 JS 浮点算钱。**2026-10-15 定版**：金额列 `Decimal(14,2)`、汇率 `Decimal(12,8)`、**账本面值币种 = CNY**（旧库对客全链路实测是人民币；对日市场 ≠ 记账用日元，见 docs/plans/finance-schema.md §3.3） |

## 构建与运行（复制粘贴用）

```bash
pnpm install            # 装依赖（首次）
pnpm db:generate        # 生成 Prisma client（改 schema 后、typecheck 前必跑）
pnpm typecheck          # 全仓类型检查（提交前必跑）
pnpm build              # 全仓构建
pnpm dev                # 启动所有 app（web:3000 / mzk:3001 / admin:3002）
pnpm --filter @crossbuy/worker dev   # 只起 worker（需 Redis）
```

会话内构建一律走 `pnpm` 命令；日志若需收敛，用 `pnpm build --output-logs=errors-only`，禁整段构建日志灌进上下文。

## 开发铁律（每条一两句，细则见 docs/07）

1. **金额不可信**：金额一律服务端重算 + `utils/money` 单入口 + ledger 留痕，禁 JS 浮点。
2. **幂等**：所有 webhook/队列消费/拉单必须幂等（1688 会重复投递）；禁「先查后插」，用唯一键 upsert。
3. **唯一写入口**：账本/余额/库存这类并发加减列，只允许一个写方法，守卫下到原子 UPDATE 的 WHERE。
4. **状态机 cas**：`UPDATE ... WHERE status=from`，禁「先查后改」。
5. **模块无横向依赖**：业务域间禁互相 import，跨域走 `packages/contract`。
6. **契约物理隔离**：`contract` 包唯一依赖 zod，禁出现 ORM/框架类型。
7. **事务内不搞外呼**：HTTP/推送移出事务，AFTER_COMMIT 或事件后再调外部 API。
8. **生成器优先 + token 纪律**：同构样板禁 AI 手写；复杂逻辑只留 `TODO(编号)`，编号登记 TODO.md。
9. **验证才敢说完成**：声称「通过/修好/完成」前必须跑验证命令并出示输出。
10. **旧系统只读**：绝不改 `haiou/` 任何文件、绝不提交、绝不改旧库数据。

## 目录速查表（状态化，改完更新状态行，禁止追加日期流水账）

| 路径 | 职责 | 状态 |
|---|---|---|
| `apps/web` | 前台 www（对日电商） | 🟢 **M1 member 链路已落地**（2026-10-17：/member 页 RSC 直调域服务 + 登录/登出/PATCH 路由 + jose JWT 会话 + 端到端 smoke 31 断言；Tailwind 4 + 共享 UI，M0.6） |
| `apps/mzk` | 代发端（dfFlag） | 🟡 骨架（Tailwind 4 + 共享 UI 已接，M0.6） |
| `apps/admin` | 运营后台（替代 dcat-admin） | 🟡 骨架（Tailwind 4 + 共享 UI 已接，M0.6） |
| `apps/worker` | BullMQ 队列 + 定时任务 | 🟡 骨架 |
| `apps/api` | 机器面 API（open API + webhook，Fastify） | 🔴 docs/04 新增，待脚手架 |
| `packages/db` | Prisma schema + 客户端；`sql/` 迁移 SQL | 🟢 **R1 活跃 schema = legacy introspect（生产版）**（2026-10-16：`prisma/schema.prisma` = 生产 PolarDB `taotaro`（MySQL 8.0.18）**179 模型**，跳板机隧道 + gouba007 只读拉取；`dg_mail1` 是视图无模型、21 张 deprecated 原样入模；`pull:legacy` = pull + `post-pull-fixup.mjs`（撞名修复 + 头部自愈）；生产 dg_users 75 列/22,628 行；WorldFirst 五表存在但全空；provenance 见 `docs/plans/07` §三）+ **R2 封存资产** = `prisma/redesign/schema.prisma` 60 模型（member+finance+order+send-order，金额 `Decimal(14,2)`/面值 CNY，#11b 定版 + finance 12 表 `0015`；✅ #3g 空库全链跑绿 03 §十 + `0016~0018` 回填跑绿 03 §十一 994,279 分录）；**双 generator 双 client**（`src/generated/{legacy,redesign}`，`client.ts` 导出 `legacyPrisma`/`redesignPrisma`）均纳入 db:generate + typecheck + 运行时冒烟；`sql/0001~0018` 同批封存，T0/T1 生产执行暂缓 |
| `packages/contract` | API 契约（TS 类型 + zod） | 🟢 core（统一响应体 Envelope，M1 从 apps/api 上移）+ member 样板（登录/资料读/资料编辑词表与 schema） |
| `packages/utils` | 金额/Result/分页/品牌类型 | 🟢 已建 |
| `packages/domains/*` | 11 域包（member/order/purchase/send-order/logistics/platform/finance/ticket/content/openapi/wms-gateway）：service 接口 + repository 防腐层（`scripts/scaffold-domains.mjs` 生成，禁手写同构样板） | 🟢 M0.2 骨架落地（每域 errors/repository/service 三件套；repository = 唯一可 import @crossbuy/db 的位置，ESLint 边界规则强制 + `scripts/boundary-probe.mjs` 破坏验证 5/5）；**member 域 M1 切片已落地**（登录全闸门/资料读/资料编辑 + 限流与口令端口 + 头像怪癖复现，37 单测） |
| `packages/notify` | 通知渠道抽象（email/dingtalk/Mns，基础设施非域） | 🟢 接口面（实现随域铺开） |
| `packages/auth` | 会话类型 + **Principal/TokenVerifier 抽象**（M0.3：域服务只认 Principal，三端各自实现 verifier，R3 抽认证中心零改动） | 🟢 类型 + 抽象 |
| `packages/ui` | 设计 token + **三 app 共用组件源**（`src/styles/theme.css` Tailwind 4 CSS-first 正本、`src/components/ui/` 7 个 new-york 基础组件、`src/lib/cn.ts`） | 🟢 M0.6 落地（产物 CSS 断言 + @source 破坏验证双向过） |
| `packages/config` | env 校验 + 共享配置 | 🟢 已建 |

## 收尾纪律

- 只有**拍板/坑级**任务才写 `docs/devlog/`，纯 CRUD/同款批量不写（写了没人看）。
- 状态变更只更新上面的速查表状态行，**禁止往 AGENTS.md 追加「做了什么」段落**。
- 复杂逻辑留的 `TODO(编号)` 必须先登记 `TODO.md`，编号不复用不重排。
