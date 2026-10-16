# crossbuy — 淘太郎平台重写

面向**日本市场**的**中国商品代购平台**（`yiwutaro.com`）的全栈重写项目。

原系统（`haiou` 仓库，Laravel 12 + dcat-admin + Astro/Deno 前端）已运行 5 年 3 个月（2021-07 ~ 2026-10），历经五批团队接力开发，存在领域模型混乱、对账体系缺失、私有依赖无主等问题。本仓库是对它的技术栈与架构的**系统性重做**。

## 关键决策摘要

| 决策 | 结论 | 一句话理由 |
|------|------|-----------|
| 语言 | 全 TypeScript | 单语言 + 强类型，对 AI 写代码最友好 |
| 前端 | Next.js + Tailwind + shadcn/ui | AI 语料最丰富、SSR/SEO 强、组件质感好 |
| 后端 | Next.js 全栈（API Routes / Server Actions） | 与前端同仓同语言 |
| 后台任务 | 独立 TS Worker（BullMQ + Redis） | 扛订单同步 / webhook / 结算等重活 |
| 数据库 | MySQL 8 + Prisma | 沿用现有库，类型安全 ORM |
| 仓库结构 | **Monorepo（pnpm workspace + Turborepo）** | 类型跨前后端共享 |
| WMS | **独立项目（未来另建 `own/wms`）** | 独立业务系统 + 独立部署，非代码共享 |

> 明确排除：若依（定制层 AI 不熟、双语言）、NestJS（比简洁不如 Next.js、比成熟不如 Java 的中间态）、Deno/Astro/Vue（原系统的冷门割裂栈）。

## 目录结构

```
crossbuy/
├── apps/
│   ├── web/        # 前台 www.yiwutaro.com（对日电商，SSR/SEO，会员业务）
│   ├── mzk/        # 代发端 mzk.yiwutaro.com（dfFlag 用户）
│   ├── admin/      # 后台管理 admin.yiwutaro.com（替代 dcat-admin）
│   └── worker/     # 后台任务进程（BullMQ 消费者 + 定时任务）
├── packages/
│   ├── ui/         # 共享 shadcn 组件 + 设计 token（三端共用）
│   ├── db/         # Prisma schema + 数据库客户端（全端共用）
│   ├── contract/   # API 契约：TS 类型 + zod schema（前后端 + worker 共用）
│   ├── config/     # tsconfig / eslint / tailwind 共享配置
│   ├── auth/       # 认证逻辑（会员 JWT / 后台会话）
│   └── utils/      # 通用工具（金额、日期、格式化）
└── docs/           # 设计文档（见下）

.workbuddy/         # AI 工作目录 —— 仅 memory/ 与 skills/ 入库，其余全部忽略
```

## 仓库卫生：`.workbuddy/` 只保留人类资产

`.workbuddy/` 是 AI 工作目录，会不断产生会话产物（`.genie` 应用文件、临时脚本、会话快照等）。
本仓库约定：**整个目录忽略，只放行两个子目录**。

| 路径 | 入库 | 说明 |
|---|---|---|
| `.workbuddy/memory/` | ✅ | **项目记忆**——长期结论 `MEMORY.md` + 每日日志 `YYYY-MM-DD.md`。跨会话可复用的项目知识与血泪坑，是本仓库知识资产的一部分 |
| `.workbuddy/skills/` | ✅ | **项目技能**——6 个外部引入技能 + 项目专属补丁（用法见 [AGENTS.md](./AGENTS.md) 的「技能」小节） |
| 其余（`.genie`、临时脚本、会话快照……） | ❌ | 一律不入库 |

这两个路径是**工具链固定**的（记忆写在 `.workbuddy/memory/YYYY-MM-DD.md`、项目级技能读
`.workbuddy/skills/`），所以不能为了躲 `.gitignore` 把它们搬到别处——搬家等于让工具找不到。
规则实现见 `.gitignore` 的 `---- WorkBuddy 工作目录 ----` 段。

改技能的**正确入口**是 `scripts/import-claude-skills.mjs` 里的 `PROJECT_PATCHES`，
不要直接改 `.workbuddy/skills/` 下的文件——下次重跑脚本会整目录覆写，改动会静默丢失。

## 设计文档

- [AGENTS.md](./AGENTS.md) ← **AI 会话入口（项目宪法）**
- [TODO.md](./TODO.md) ← 待办 + 红线与坑
- [00 原项目参考指南](./docs/00-原项目参考指南.md) ← 旧系统在哪、怎么读、雷区速查
- [01 技术栈定稿](./docs/01-技术栈定稿.md)
- [02 架构与模块设计](./docs/02-架构设计.md)
- [03 迁移路线](./docs/03-迁移路线.md)
- [06 开发计划](./docs/06-开发计划.md)
- [07 开发规范守则](./docs/07-开发规范守则.md)

## 与原系统的关系

本仓库是**全新实现**，不迁移旧代码，只「参考」旧系统的业务逻辑与数据模型。

- 旧系统位置：`D:/Work/project/haiou/`（`backend` + `frontend` + `mzk-frontend` 三个仓库）
- 旧系统在过渡期内**继续生产运行**，两者通过**共用同一套 MySQL** + 一致的 API 契约并行
- **读取纪律：旧系统只读参考，绝不修改**（详细地图与雷区见 [docs/00](./docs/00-原项目参考指南.md)）
