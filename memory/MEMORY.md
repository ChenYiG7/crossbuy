# 项目长期记忆 — crossbuy（淘太郎平台重写）

> 本文件只留**跨会话必带**的结论与红线；细节在 `docs/plans/*`、`.workbuddy/memory/YYYY-MM-DD.md`。

## 是什么 / 总纲（docs/04 为现行总纲）
面向日本市场的中国商品代购平台 `yiwutaro.com` 全栈重写（`D:/Work/project/own/crossbuy`）。旧系统 `D:/Work/project/haiou/`（Laravel12+dcat-admin+GraphQL、Astro/Deno/Vue、mzk-frontend）**生产运行中、只读参考、绝不改不提交**；过渡期新旧共用同一 MySQL。
- **R1 复现期（当前）**：数据库**不动**——Prisma introspect 旧表直接读写（零新表/零回填/零双写）。防腐层 = repository 是旧表唯一触点（时间戳 Asia/Shanghai、collation 按 `utf8_general_ci` 语义、金额保持旧精度、MD5 密码 1:1——**argon2id 透明升级 R1 不可行**：旧列 `CHAR(32)` 装不下 ~97 字符哈希且禁加列，端口已留）。接口面：客户面在 web/mzk（BFF+RSC 直调）、后台面在 admin、机器面独立 `apps/api`（Fastify）；域逻辑全下沉 `packages/domains/*`；PHP 唯一写方直到域绞杀；按域灰度、URL/SEO 1:1 平移。里程碑 M0 基建→M1 member→M2 交易→M3 履约→M4 后台+finance→M5 PHP 退役。
- **R2 优化期（用户择机启动）**：数据库重构 = 60 模型新表 + T0/T1 回填（资产原样启用），代码层仅 repository 从 legacy 切 redesign schema。
- **R3 平台化**：认证中心 + 系统拆分（admin/oms/wms/财务/CRM）+ 账本四方对账。拆分纪律现在执行：表唯一属主、域间走 service 接口 + 契约事件、contract 无框架类型。

## 技术栈（定版 2026-10-12）
全 TS：Next.js 15 App Router（`apps/{web,mzk,admin}`）+ Tailwind 4/shadcn；`apps/worker`=Node+BullMQ/Redis；Prisma 6+MySQL 8；zod 契约；decimal.js 金额单入口；pnpm+Turborepo（`packages/{ui,db,contract,config,auth,utils}`）。WMS 独立项目，主系统只留 `wms-gateway`。信息源优先级：`AGENTS.md > docs/07 > TODO.md > docs/01~06 > 源码注释 > 代码`。

## 迁移铁律
禁 Big Bang｜按域垂直切片端到端跑通再切｜**共用旧表、写入口按域切换**（PHP 唯一写方直到域绞杀）｜金额服务端重算+Decimal+唯一写入口｜webhook/队列消费幂等｜**部署粒度 = app 级**（五 app 五部署单元，域写路径变更才协同发该域写方进程；新域准入三判据；FBA=业务线非域）。

## 环境
- 生产 PolarDB `taotaro`（测试 `taotaro_test` 账号 `wms_app`）需经跳板机 `114.215.206.28` 端口转发；生产账号 `datapro` **只读** ⇒ DDL/DML 必须 DBA 执行。密码只从 `C:/Users/13621/.taotaro-db.pass`/环境变量取，**不入代码与文档**。
- 本机 `taotaro` = 旧 dump 尾切片（dg_users 74 列 vs 生产 75、5,021 会员、160/174 表）⇒ 演练脚本逐表择优取源 + 审计表 + 安全守卫。
- **本机 FlyEnv MySQL 默认没启动**，测试报 `Can't reach database server` 时先起：`"D:/Program Files/FlyEnv-Data/app/mysql-9.7.2/mysql-9.7.2-winx64/bin/mysqld.exe" --defaults-file="D:/Program Files/FlyEnv-Data/server/mysql/my-9.7.cnf" --console`。⚠ **它会中途自己停**（实测会话跑到一半 3306 就没监听了）；且若在库就绪**之前**启动 smoke，smoke 会一直挂到超时而不报错。
- **Redis 同样默认没起**（`@crossbuy/cache` 测试需要）：`"D:/Program Files/FlyEnv-Data/app/redis-8.10.2/Redis-8.10.2-Windows-x64-msys2/redis-server.exe" redis.conf`。
- MySQL 9.7.2 坑：无 `MD5()`；`AUTO_INCREMENT=(子查询)` 要 `PREPARE`；mb3 字符串套 mb4 collation 先 `CONVERT(... USING utf8mb4)`。

## 进度（2026-10-17）
- **M0 基建基本完成**：legacy introspect（生产 179 模型，双 generator 双 client，`pull:legacy`=pull+`post-pull-fixup.mjs` 含头部自愈）｜11 域包骨架 + ESLint 边界规则（`scripts/boundary-probe.mjs` 破坏验证 5/5）｜auth Principal/TokenVerifier｜180 表属主映射（`scripts/classify-table-owners.mjs`，未归类=0 硬门禁）｜apps/api（Fastify，24 断言）｜Tailwind 4 + shadcn｜Vitest 基线（真实 MySQL，事务回滚）｜部署管线（per-app standalone/tsup + `scripts/deploy.mjs` + 影响半径）。剩余：vendor 冷备（需公司存储）。
- **M1 member 切片**：登录全闸门/资料读/资料编辑 22 字段/收藏增删/admin 只读用户列表 + jose JWT 会话 + 53 单测 + smoke 44 断言。剩余：PHP↔TS 双跑 diff + nginx 灰度（依赖 M0.8）。
- **M2 交易链路：已闭环**（契约迁移白名单、取消、列表 20 项筛选、1688 支付/物流 webhook、发货回传、运单列表、购物车读写、加购、下单、**chrome 回传** 全部 1:1，order 域 129 单测）。剩余两块都卡 SDK：chrome 的 GET(3)/GET_STATE_PAID(7)/CREATE_1688_ORDER(8) 与淘宝 API 改单 = TODO #18（其中 1688 详情 SDK 是**半阻塞**：不迁则 chrome 回传 `trade_type=1` 一律不可用）；淘宝全球购三族 = M3。
- **#16① 已收口**：新增 `@crossbuy/cache`（Redis 分布式锁 + 冷却），下单/加购两处进程内 Map 闸门改 Redis，无 `REDIS_URL` 回退内存**并打 WARNING**；17 单测跑真 Redis。剩余 #16②（下单四个副作用投递接 worker 真 Job = #7）与 #16③（两处 SDK 端口）。

## 血泪坑（按代价排序）
1. **ODKU 只适用于「撞键=同一实体重复投递」**：业务属性型唯一键（username）撞键=两个实体，ODKU 会**静默整行覆盖**（实测吞 5 账号、清零 2 笔余额、零报错）⇒ fail-fast `SIGNAL`；唯一性按**目标列 collation** 判。
2. **校验脚本会造假绿**：`ROW_COUNT()` 在 `DEALLOCATE` 后被重置为 0；`grep -c FAIL` 会数进 SQL 字面量；`2>/dev/null` 把 `ERROR 2003` 吞成「0 行」。⇒ 用结果列精确统计，任何「0/空」都要第二来源交叉核对。**「跑绿」≠「守卫有效」**——守卫要主动破坏一次看它 `rc=1`。
3. TEMPORARY 表不能承载回填输入；校验 expected 按当前源实时算，禁写死快照。
4. 带 member 必需关系的表回填要 `JOIN member` 过滤外键孤儿（favorite 240/browse 3389/benefit 3/log 68）。
5. `dg_users` 有 id 空洞 ⇒ 顶自增用 `MAX(id)+1`。
6. 口径清扫时非金额列别盲替换（`float_rate`/`order_weight`/`low_multiple`；`v2_ecommerce_shop.currency` 是外部平台结算币种）。
7. 已演练通过的列定义别顺手改。
8. **Windows+monorepo+Prisma 文件追踪三连坑**：nft 把 dotenv 的 `~` 求值成 `C:\Users\<user>\**\*` 并 glob 整个 home → EACCES（编译成功、死在 trace；没 bundle Prisma 的 app 构建绿是**假绿**）；`NEXT_PRIVATE_OUTPUT_TRACE_ROOT` env 设了白设，必须设 `outputFileTracingRoot` **配置字段**；nft 的 ignore 在**跨盘符**失效 ⇒ 正解 = build 期把 USERPROFILE/HOME 重定向到**同盘**。相位只能用函数式配置入参拿。修法全文见 `apps/web/next.config.ts`；mzk/admin bundle Prisma 时要复制。
9. `next.config.ts` 的 JSDoc 禁出现 `*/` 序列（写 glob `/**\/*` 会提前终止块注释）。
10. tsx 跑 `.ts` 顶层 await（非 ESM 包）报 `ERR_REQUIRE_ASYNC_MODULE` ⇒ 独立 smoke 用 `.mts`。
11. **ioredis `enableOfflineQueue:false` + `lazyConnect:true` ⇒ 进程启动后第一个命令必失败**（`Stream isn't writeable`）。要么显式 `waitForRedis()`（已封装在 `@crossbuy/cache`），要么别这么配。分布式锁的释放**必须带 token 比对**（Lua），否则超时后的旧持锁者会删掉新持锁者的锁，互斥被击穿且日志全「正常」。
12. `turbo run test --force` 会连带重跑 `db#generate`，本机撞 **EPERM 重命名 `query_engine-windows.dll.node`**（文件被占用）⇒ 要未缓存的测试结果就进各包直接 `pnpm exec vitest run`。mzk 构建偶发 `EPERM symlink`（standalone 拷贝）**重跑即过**，别当代码问题查。

## 工具链红线
- ★ **Prisma 产物 `src/generated/**` 在源码树**，turbo 缓存命中会跳过生成却仍报成功 ⇒ `generate` 必须进依赖图且 `cache:false`（`packages/db/turbo.json` 让 db 的 build/typecheck 都 `dependsOn:["^build","generate"]`；db 在最上游 ⇒ **build 过 ≠ typecheck 过**）；db 的 build 脚本内不再调 generate，保留 `prebuild`/`pretypecheck` 给直接 pnpm 调用兜底（turbo 不触发生命周期钩子）。
- ★ **package.json 是严格 JSON 禁 `//` 注释**（turbo.json/tsconfig.json 支持 jsonc 是特例），pnpm 会报 `ELIFECYCLE` 且错误信息指向注释文字本身。
- **`.gitignore` 整体忽略 `.workbuddy/*` 但放行 `memory/` 与 `skills/`**——这两个是工具链固定路径，不可搬；改后用 `git check-ignore -v` 双向验证。
- **技能**在 `.workbuddy/skills/`（6 个：verification-before-completion / systematic-debugging / test-driven-development / writing-plans / executing-plans / finishing-a-development-branch）。★ **项目专属补丁正本是 `scripts/import-claude-skills.mjs` 的 `PROJECT_PATCHES`**，绝不直接改 skills 目录（重跑会整目录覆写）。项目级技能需重启会话才进可调用列表，刷不出时直接读 SKILL.md。

## 旧系统继承的结论（重写必须规避）
- **零对账**：`Σ流水=余额` 无校验，`dg_record` 链断 7.3%（36,482 环）/55% 会员 ⇒ 新系统必须**逐环校验**。WorldFirst `v2_worldfirst_*` 五表生产实测**全部 0 行**（空壳死表）。
- 旧「幂等列」不可信（`dg_record.idempotency_key` 全 NULL 零读写）；判重全是「先查后插」⇒ 新幂等 = 唯一键 + 命令侧算 key。
- 后门/裸奔：`skip_price_check`、后台改价、`dg_rechargerecord` 可改 money/state/汇率反算、`dg_huilv` 全字段可手改、PayPal 回调仅 2s `Cache::lock`、月费/仓储费 Job 无锁可扣成负、**充值「初审通过即入账」**。
- 领域硬伤：`bargainprice` 在 Order/SendOrder 语义不同、`goodsprice` vs `goodsprice1`、各域 status 独立状态机不可跨域假设。
- `dg_users.money` decimal(10,2) 实测 max 99,999,350.04（距上限 65 元，溢出风险）。
- 会员主表 `dg_users`；`v2_address`/`v2_area` 是行政区划字典（非收货地址）；`dg_record`=余额流水（type 方向+action 原因+accountmoney 快照），`finance_order_cash_flow`=财务代付动作流水。
- 团队：2-3 名 Java 背景员工接管，兼职张（现主力）将离开 ⇒ 知识盘点是重写前置。`own/` 下 `agent`/`ec-erp`/`system-kit` 是个人项目，勿动。
