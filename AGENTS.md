# AGENTS.md — crossbuy 项目宪法（AI 会话入口）

> 本文档是每个 AI 会话冷启动的「必装上下文」。磁盘是唯一可信状态，聊天记录不是。

## 信息源优先级（冲突时按此裁决）

`本文件 > docs/07 开发规范守则 > TODO.md > docs/01~06 > packages/*/源码注释 > 代码`

## 必读区（做某类事前必读）

| 要做的事 | 先读 |
|---|---|
| 接手任何任务 | 本文件 + `TODO.md`（红线与坑） |
| 写任何代码 | `docs/07-开发规范守则.md`（唯一写入口/幂等/金额/状态机/防腐层） |
| 设计表结构 | `docs/07` §schema 规约 + `packages/db/prisma/schema.prisma` |
| 参考旧系统业务 | `docs/00-原项目参考指南.md`（旧系统在哪、怎么读、雷区） |
| 规划一个域 | `docs/06-开发计划.md`（分阶段路线） |

## 项目是什么

面向**日本市场**的**中国商品代购平台**（`yiwutaro.com`）的全栈重写。原系统 `D:/Work/project/haiou/`（Laravel + Astro/Deno）生产运行中，**只读参考，绝不修改**。过渡期新旧共用同一 MySQL。

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
| 金额 | decimal.js（`utils` 单入口） | ^10.4 | 禁 JS 浮点算钱 |

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
| `apps/web` | 前台 www（对日电商） | 🟡 骨架 |
| `apps/mzk` | 代发端（dfFlag） | 🟡 骨架 |
| `apps/admin` | 运营后台（替代 dcat-admin） | 🟡 骨架 |
| `apps/worker` | BullMQ 队列 + 定时任务 | 🟡 骨架 |
| `packages/db` | Prisma schema + 客户端；`sql/` 迁移 SQL | 🟡 member 域新表正本（17 模型）+ T0 DDL 已生成，其余域待建 |
| `packages/contract` | API 契约（TS 类型 + zod） | 🟢 core + member 样板 |
| `packages/utils` | 金额/Result/分页/品牌类型 | 🟢 已建 |
| `packages/auth` | 会话类型（会员/后台） | 🟡 仅类型 |
| `packages/ui` | 设计 token（shadcn 待接） | 🟡 仅 token |
| `packages/config` | env 校验 + 共享配置 | 🟢 已建 |

## 收尾纪律

- 只有**拍板/坑级**任务才写 `docs/devlog/`，纯 CRUD/同款批量不写（写了没人看）。
- 状态变更只更新上面的速查表状态行，**禁止往 AGENTS.md 追加「做了什么」段落**。
- 复杂逻辑留的 `TODO(编号)` 必须先登记 `TODO.md`，编号不复用不重排。
