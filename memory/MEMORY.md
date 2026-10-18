# 项目长期记忆 — crossbuy（淘太郎平台重写）

> 只留**跨会话必带**的结论与红线；细节在 `docs/plans/*`（含 `08-R2优化清单.md` = 怪癖 S1~S56 正本）、`TODO.md`、`.workbuddy/memory/YYYY-MM-DD.md`。**进度细节勿写回本文件**——记当日日志即可。

## 总纲（docs/04 现行）
日本市场中国商品代购平台 `yiwutaro.com` 全栈重写（`D:/Work/project/own/crossbuy`）。旧系统 `D:/Work/project/haiou/`（Laravel12+dcat-admin+GraphQL、Astro/Deno/Vue、mzk-frontend）**生产运行中、只读参考、绝不改不提交**；过渡期新旧共用同一 MySQL。
- **R1 复现期（当前）**：数据库不动，Prisma introspect 旧表直接读写；repository = 旧表唯一触点（时间戳 Asia/Shanghai、collation 按 `utf8_general_ci` 语义、金额旧精度、MD5 密码 1:1——argon2id 升级 R1 不可行，端口已留）。接口面：客户面 web/mzk（BFF+RSC）、后台 admin、机器面 `apps/api`（Fastify）；域逻辑全下沉 `packages/domains/*`；PHP 唯一写方直到域绞杀；按域灰度、URL/SEO 1:1。里程碑 M0 基建→M1 member→M2 交易→M3 履约→M4 后台+finance→M5 PHP 退役。
- **R2 优化期（择机）**：60 模型新表 + T0/T1 回填（资产原样启用），仅 repository 切 redesign schema。**R3 平台化**：认证中心 + 系统拆分 + 四方对账；拆分纪律现在执行（表唯一属主、域间 service 接口、contract 无框架类型）。

## 技术栈 / 铁律
全 TS：Next.js 15 App Router（`apps/{web,mzk,admin}`）+ Tailwind 4/shadcn；`apps/worker`=Node+BullMQ/Redis；Prisma 6+MySQL 8；zod 契约；decimal.js 金额单入口；pnpm+Turborepo（`packages/{ui,db,contract,config,auth,utils}`）。信息源优先级：`AGENTS.md > docs/07 > TODO.md > docs/01~06 > 源码注释 > 代码`。
铁律：禁 Big Bang｜按域垂直切片｜共用旧表、写入口按域切换｜金额服务端重算+Decimal+唯一写入口｜webhook/队列幂等｜部署粒度 = app 级｜FBA=业务线非域。

## 环境速查
- 生产 PolarDB `taotaro` 经跳板机 `114.215.206.28` 端口转发；生产 `datapro` 只读 ⇒ DDL/DML 必须 DBA。密码只从 `C:/Users/13621/.taotaro-db.pass`/环境变量取。
- 本机 MySQL/Redis 默认没起；MySQL 会**中途自己停**。MySQL 启动：`"D:/Program Files/FlyEnv-Data/app/mysql-9.7.2/mysql-9.7.2-winx64/bin/mysqld.exe" --defaults-file="D:/Program Files/FlyEnv-Data/server/mysql/my-9.7.cnf" --console`；Redis：`"D:/Program Files/FlyEnv-Data/app/redis-8.10.2/Redis-8.10.2-Windows-x64-msys2/redis-server.exe" redis.conf`。库就绪前跑 smoke 会挂到超时不报错。
- MySQL 9.7.2 坑：无 `MD5()`；`AUTO_INCREMENT=(子查询)` 要 `PREPARE`；mb3 套 mb4 collation 先 `CONVERT(... USING utf8mb4)`。

## 进度指针（2026-10-18；细节写当日日志，勿改此段）
- M0 基本完成（剩 vendor 冷备）；M1 member 完成（剩 PHP↔TS 双跑 diff + nginx 灰度，依赖 staging）；M2 交易链路已闭环（order 域 129 单测）。#6/#7/#16①/#16②/#17/#11f/**1688 详情 SDK 迁移（#18 半阻塞解除）**/**S35 规格翻译**/**S39 URL 解析器三件套** 均已收口（详见 2026-10-18 日志）。
- **下一步**：① **S41 店铺反解（已评估解阻塞）**——`searchShopNameByGoodsId` 与已迁 fenxiao 详情同 API 只取 sellerOpenId，接线点 = 组合根 `AlibabaShopPort`；② #18 剩余四块——③1688 建单随后台采购面（M3）；④ 淘宝全球购改单需 **taobao SDK**（唯一真实技术阻塞）；③ #16③ 剩 S34（实时价——ContentParser 已迁，只差淘宝侧 `getFormatGoodsInfo`）与另三个副作用投递（翻译/商品补全/MNS）；④ M1 双跑 diff（staging）；⑤ git push（**30+ 提交待推，用户手动**）。

## 血泪坑（浓缩；原文全在 2026-10-15~18 日志）
1. ODKU 只适用「撞键=同一实体」；业务属性唯一键（username）撞键=两实体 ⇒ fail-fast `SIGNAL`；唯一性按**目标列 collation** 判。
2. 校验脚本假绿三坑（`ROW_COUNT()` 重置 / `grep -c` 数进字面量 / `2>/dev/null` 吞 ERROR 2003）；**跑绿≠守卫有效，守卫要破坏一次看 rc=1**。
3. T1 族：TEMPORARY 不能当回填输入；expected 按当前源实时算；带 member 必需关系的表回填 `JOIN member` 过滤孤儿；`dg_users` 顶自增用 `MAX(id)+1`；非金额列别盲替换（`float_rate`/`order_weight`/`low_multiple`）。
4. Windows+monorepo：nft 跨盘符坑正解见 `apps/web/next.config.ts`（`outputFileTracingRoot` 配置字段 + build 期重定向 USERPROFILE/HOME 同盘）；**web `next build` 受 `.next/trace` EPERM 阻断**（环境问题，用 `pnpm --filter @crossbuy/web smoke` 验功能）；`turbo run test --force` 撞 Prisma 引擎 EPERM ⇒ 进各包直接 `pnpm exec vitest run`；mzk EPERM symlink 重跑即过。
5. **域包测试文件无类型门禁**（tsconfig include 只有 `src/**`）——测试类型对不对只能靠 vitest 跑；跨域包靠 vitest alias，不必进 deps 但漏配 = 运行时解析失败。
6. ioredis `enableOfflineQueue:false+lazyConnect:true` ⇒ 首命令必失败 ⇒ `waitForRedis()`（已封装 `@crossbuy/cache`）；分布式锁释放必须 Lua token 比对。
7. **prettier 会把 md 裸文成对单星号改 `_` 且 format:check 查不出** ⇒ glob 星号一律进 code span；守卫 `scripts/check-md-stars.mjs` 已上线（CI 第 7 步）。
8. Windows mysql CLI 默认 gbk ⇒ 跑含 CJK 的 SQL（0016/0017/0018）**必须** `--default-character-set=utf8mb4`。本机 `crossbuy_t1v` 演练库常驻（994,279 分录态），改 finance SQL 直接重跑 0017→0018 验证（ODKU 幂等自愈）。
9. 无本机符号链接权限 ⇒ standalone 构建死在 symlink 属环境；tsx 跑顶层 await `.ts` 报 `ERR_REQUIRE_ASYNC_MODULE` ⇒ smoke 用 `.mts`。
10. **web smoke 后台跑会「假卡死」**：smoke 脚本派生的 `next start` **不被回收**，主体早已结束但孤儿 server 占着 stdout 管道 ⇒ `... | tail` 永远等不到 EOF（表象：数十分钟无输出）。修法：PowerShell `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 找 `next start` PID 杀掉即 flush 出真实结果。

## 工具链红线
- Prisma 产物 `src/generated/**` 在源码树 ⇒ `generate` 必须进依赖图且 `cache:false`（`packages/db/turbo.json`）；**db build 过 ≠ typecheck 过**。
- `package.json` 严格 JSON 禁注释（turbo.json/tsconfig 支持注释是特例）。
- `.gitignore` 忽略 `.workbuddy/*` 但**放行 `memory/` 与 `skills/`**（工具链固定路径不可搬）。
- 技能（6 个）在 `.workbuddy/skills/`；**项目专属补丁正本 = `scripts/import-claude-skills.mjs` 的 `PROJECT_PATCHES`**，绝不直接改 skills 目录。

## 旧系统继承结论（重写必须规避）
- 零对账：`Σ流水=余额` 无校验，`dg_record` 链断 7.3%/55% 会员 ⇒ 新系统逐环校验。WorldFirst 五表生产实测全 0 行（空壳死表）。
- 旧幂等列不可信（全 NULL）；判重全是先查后插 ⇒ 新幂等 = 唯一键 upsert + 命令侧算 key。
- 后门缺陷族（#11a 七条，对策落 `finance-schema.md`）：PayPal 仅 2s 锁、后台改 money/state/汇率、`dg_huilv` 可手改、初审即入账、月费/仓储费 Job 无锁、MYR 段 ≈ 套日元汇率（701 行 RATE_DRIFT）。
- 领域硬伤：`bargainprice` 在 Order/SendOrder 语义不同、`goodsprice` vs `goodsprice1`、各域 status 独立状态机不可跨域假设；`dg_users.money` decimal(10,2) 濒上限。
- 团队：2-3 名 Java 背景员工接管，兼职张（现主力）将离开。`own/` 下 `agent`/`ec-erp`/`system-kit` 是个人项目，勿动。
