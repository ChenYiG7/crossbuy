# crossbuy — 淘太郎平台重写

面向**日本市场**的**中国商品代购平台**（`yiwutaro.com`）的全栈重写项目。

原系统（`haiou` 仓库，Laravel 12 + dcat-admin + Astro/Deno 前端）已运行 5 年 3 个月（2021-07 ~ 2026-10），历经五批团队接力开发，存在领域模型混乱、对账体系缺失、私有依赖无主等问题。本仓库是对它的技术栈与架构的**系统性重做**。

## 关键决策摘要

| 决策     | 结论                                        | 一句话理由                            |
| -------- | ------------------------------------------- | ------------------------------------- |
| 语言     | 全 TypeScript                               | 单语言 + 强类型，对 AI 写代码最友好   |
| 前端     | Next.js + Tailwind + shadcn/ui              | AI 语料最丰富、SSR/SEO 强、组件质感好 |
| 后端     | Next.js 全栈（API Routes / Server Actions） | 与前端同仓同语言                      |
| 后台任务 | 独立 TS Worker（BullMQ + Redis）            | 扛订单同步 / webhook / 结算等重活     |
| 数据库   | MySQL 8 + Prisma                            | 沿用现有库，类型安全 ORM              |
| 仓库结构 | **Monorepo（pnpm workspace + Turborepo）**  | 类型跨前后端共享                      |
| WMS      | **独立项目（未来另建 `own/wms`）**          | 独立业务系统 + 独立部署，非代码共享   |

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

skills/             # 项目技能（6 个外部引入 + 项目补丁，用法见 AGENTS.md「技能」）
memory/             # 项目记忆（MEMORY.md 血泪坑正本；每日日志不入库）
```

## 仓库卫生：`.workbuddy/` 不入库，人类资产在根目录

`.workbuddy/` 是 AI 工作目录，会不断产生会话产物（临时脚本、会话快照等）——**整体忽略，一律不入库**。

| 路径                   | 入库 | 说明                                                                                            |
| ---------------------- | ---- | ----------------------------------------------------------------------------------------------- |
| `skills/`              | ✅   | **项目技能**——6 个外部引入技能 + 项目专属补丁（用法见 [AGENTS.md](./AGENTS.md) 的「技能」小节） |
| `memory/MEMORY.md`     | ✅   | **项目记忆**——跨会话可复用的项目知识与血泪坑正本，本仓库知识资产的一部分                        |
| `memory/YYYY-MM-DD.md` | ❌   | 每日会话日志 = 会话产物，不入库（2026-10-20 起连同历史一并清除）                                |
| `.workbuddy/` 其余     | ❌   | 一律不入库                                                                                      |

2026-10-20 重组：技能与记忆正本迁根目录、`.workbuddy/` 整体忽略；历史中旧路径（`.workbuddy/skills/`、
`.workbuddy/memory/` 每日日志）已随 git-filter-repo 重写（skills 改路径保留、日志清除、空提交 prune）。

改技能的**正确入口**是 `scripts/import-claude-skills.mjs` 里的 `PROJECT_PATCHES`，
不要直接改 `skills/` 下的文件——下次重跑脚本会整目录覆写，改动会静默丢失。

## 前端 UI 基座（packages/ui，M0.6）

三 app（web/mzk/admin）**唯一组件源**，Tailwind 4 CSS-first 配置（全仓无 `tailwind.config.js`）：

| 位置                               | 职责                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/src/styles/theme.css` | 主题**唯一正本**：`@import 'tailwindcss'` + `@theme inline` 变量映射 + `:root`/`.dark` 变量本体 + base 层。app 的 globals.css 只需 `@import '@crossbuy/ui/styles.css';` |
| `packages/ui/src/components/ui/`   | shadcn（new-york 风格）基础组件，源码取自官方 registry；改组件优先 `npx shadcn add`                                                                                     |
| `packages/ui/src/lib/cn.ts`        | className 合并（clsx + tailwind-merge），`@crossbuy/ui/lib` 导出                                                                                                        |
| `packages/ui/src/tokens.ts`        | CSS 变量的 **TS 镜像**（canvas/图表场景用）；改 theme.css 必须同步它                                                                                                    |

app 接入三件套（每个 app 都已就位）：`postcss.config.mjs`（`@tailwindcss/postcss`）、`globals.css` 两行（import + `@source './**/*.{ts,tsx}'`）、tsconfig `paths`。

**★ `@source` 是承重墙**：`theme.css` 里的 `@source '../**/*.{ts,tsx}'` 显式扫描本包 components——Tailwind 自动扫描**不覆盖** monorepo 里的 ui 包，删掉它构建**照样全绿**但共享组件的样式**静默消失**（2026-10-17 破坏验证实录）。⇒ 验收 UI 改动必须 **grep 构建产物 CSS**（如 `animate-pulse`/`bg-primary` 在不在），不能只看 build 通过。

**新增组件**：`cd apps/<app> && npx shadcn@latest add X`——各 app 的 `components.json` 已把 aliases 指向 `@crossbuy/ui`（组件直接落进共享包）；组件运行时依赖装到 `packages/ui`（catalog 已收编 tailwind/shadcn 依赖族）。

其他：dark 模式 = 给 `html` 加 `.dark` class（`@custom-variant` 已配置）；`--brand` 是语义主色正本（shadcn `primary` 指向它）；涨跌配色按 A 股惯例在图表处显式给，不用 chart token 隐含。`.prettierignore` 豁免 `skills/` 与 `memory/`（上游生成技能/项目记忆不参与格式化门禁；全仓 format:check 历史欠账见 TODO #6）。

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
