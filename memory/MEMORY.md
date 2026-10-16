# 项目长期记忆 — crossbuy（淘太郎平台重写）

> 细节在 `docs/plans/`（含 `03-T1本地演练报告.md`）与 `.workbuddy/memory/YYYY-MM-DD.md` 日志，本文件只留**跨会话必带**的结论与红线。

## 是什么
面向**日本市场**的中国商品代购平台 `yiwutaro.com` 的**全栈重写**（`D:/Work/project/own/crossbuy`）。旧系统 `D:/Work/project/haiou/`（backend=Laravel12+dcat-admin+GraphQL、frontend=Astro5/Deno/Vue、mzk-frontend）**生产运行中、只读参考、绝不改不提交**；过渡期新旧共用同一 MySQL。

## ★ 现行总纲（2026-10-16 策略转向，`docs/04-重写架构方案.md`）
参照 haiou `docs/04-Java重写方案.md` 重设计但**语言不换（全 TS）**、范围扩大为**旧系统三个项目一起重做**（= Java 方案 1 期+2 期功能合并，客户前台也重做、GraphQL→REST 直上 REST，无 GraphQL 保真负担）：
- **R1 复现期**：数据库**不动**——Prisma introspect 旧表直接读写（零新表/零回填/零双写），防腐层（repository 是旧表唯一触点，时间戳 Asia/Shanghai、collation 按 `utf8_general_ci` 语义、金额保持旧精度舍入、MD5 密码登录透明升级）；接口面 = 客户面留在 web/mzk 各自 app（BFF+RSC 直调）、后台面在 admin、**机器面独立 `apps/api`（Fastify）**；域逻辑全下沉 `packages/domains/*`，apps 只做薄壳；PHP 唯一写方直到域绞杀（客户面+admin+Job 整体切写）；按域灰度、URL/SEO 1:1 平移；安全 P0/P1 后门禁复现。里程碑 M0 基建→M1 member 熔断（~6 周）→M2 交易链路→M3 履约→M4 后台全量+finance→M5 PHP 退役（粗估 6-7 月）。
- **R2 优化期（用户择机启动）**：数据库重构 = 60 模型新表 + T0/T1 回填（`docs/plans/03` 资产原样启用）；代码层仅 repository 从 legacy 切 redesign schema。
- **R3 平台化**：认证中心（auth 包 Principal/TokenVerifier 已抽象）+ 系统拆分 admin/oms/wms/财务/CRM + 账本/四方对账（finance 段 12 模型已备）。拆分纪律现在执行：表唯一属主、域间走 service 接口 + 契约事件、contract 无框架类型。

## 技术栈（定版 2026-10-12）
全 TS：Next.js 15 App Router（`apps/{web,mzk,admin}`）+ Tailwind/shadcn；`apps/worker` = 纯 Node + BullMQ/Redis（替代旧 58 Job）；Prisma 6 + MySQL 8；zod 契约；decimal.js 金额单入口；Monorepo = pnpm workspace + Turborepo（`packages/{ui,db,contract,config,auth,utils}`）。**WMS 独立项目**（未来 `own/wms`），主系统只留 `wms-gateway` 接口面。信息源优先级：`AGENTS.md > docs/07 > TODO.md > docs/01~06 > 源码注释 > 代码`。

## 迁移铁律
禁 Big Bang（新旧并行可回退）｜按域垂直切片（前后端+worker+契约端到端跑通再切）｜过渡期**共用旧表、写入口按域切换**（PHP 唯一写方直到域绞杀；2026-10-16 前的「同库双写新旧表」时序后移 R2）｜金额服务端重算 + Decimal + 唯一写入口｜webhook/队列消费幂等。

## 表重构与共存（Q7，2026-10-13 定；**2026-10-16 起封存为 R2 资产，T0/T1 生产执行暂缓**）
- **新表为唯一正本**，不继承旧结构（弃 MD5 无盐密码、money 挂用户、float 存钱、INT unix 时间戳、多态外键）。过渡期 = **同库同事务双写**新旧表（同库双表不违反铁律；读只读新表）。
- **主键对齐**：`member.id == dg_users.uid`（回填显式带 id + `PREPARE` 顶 AUTO_INCREMENT）。**例外**：`dg_record`(807万) 与 `dg_record_old`(599万) rid 空间重叠 → 分录 id 新分配，靠 `(legacy_source, legacy_id)` 对齐；单据表仍对齐。
- 时序：T0 建表 → T1 回填+读新写双 → T2 切写入口 → T3 旧表降级只读投影。
- **参数定版**：账本面值 **CNY**；金额 `Decimal(14,2)`、汇率 `Decimal(12,8)`。⚠ 曾拍 JPY，2026-10-15 实测推翻（对客链路 `dg_order.goodsprice`/`dg_users.money`/`dg_record.money`/`dg_sendorder.totalfee` 都是人民币；仅 `dg_rechargerecord.amount`/`dg_users.monpayamt` 是 JPY，按 JPY 回填会静默放大 ~22 倍）⇒ 对客金额注释**禁写 JPY**。
- `member.username` 必须显式 **`utf8mb4_general_ci`**（旧库 `utf8_general_ci`；`unicode_ci` 折叠全/半角、平/片假名 → 重名组 8 虚增到 24 且含不同人）。Prisma 无列级 collation → raw SQL `MODIFY`（`0001a`）。副作用：与其他 `unicode_ci` 列 JOIN/UNION 报 Illegal mix of collations。判尾空格比 `CHAR_LENGTH`（ci 下 `'a '='a'`）。`email` 不加唯一（`123456@qq.com` ×31 测试号）。
- 列名一律 snake_case；Prisma 多词字段必须 `@map("snake_case")`。
- DDL：**改 schema 后必须用 Prisma `--from-schema-datamodel` 重生成，禁手改**；段间**插段时后续段全部重基线**，判据 = 未改动段 `git diff` 为空。

## 环境（只读生产 + 本地演练）
- 生产 PolarDB `taotaro`（测试 `taotaro_test`，账号 `wms_app`）需经跳板机 `114.215.206.28` SSH 端口转发；密码只从文件/环境变量取（`C:/Users/13621/.taotaro-db.pass`），**不入代码与文档**。
- **生产 `datapro` 只读**（仅 SELECT/INDEX/LOCK TABLES/SHOW VIEW）⇒ T0 建表、T1 回填**必须 DBA 用写账号执行**，我方只交脚本。
- 本地演练：FlyEnv MySQL 9.7.2，库 `crossbuy_dryrun` / 验证库 `crossbuy_t1v`。本机 `taotaro` 是**旧 dump 尾切片**（`dg_users` 74 列 vs 生产 75、5,021 会员、仅覆盖 160/174 表、缺 `dg_record_old`/`v2_worldfirst_*`）⇒ 演练脚本逐表择优取源 + `_drill_import_log` 审计 + `_drill_safety_guard`（目标库=源库即 SIGNAL）。
- MySQL 9.7.2 坑：无 `MD5()`；`ALTER ... AUTO_INCREMENT=(子查询)` 要 `PREPARE`；mb3 字符串套 mb4 collation 先 `CONVERT(... USING utf8mb4)`；`DO` 不在 prepared 白名单。

## 落地进度（2026-10-16）
⚠ **当日策略转向（docs/04）：上述 60 模型方案整体封存为 R2，R1 改为直接读写旧表**；AGENTS.md/TODO.md/docs 02/03/06 已同步修订（fork 续命作废 → PHP 冻结+冷备；#3d/#3f/#11 剩余转 R2；新增 #14 = R1 启动项）。
四域新表 **60 模型**（member 16 / finance 12 / order 26 / send-order 6），DDL 四段 `0001`→`0015`→`0002`→`0003`，脚本 `packages/db/sql/0001~0018`。member 域 T0/T1/校验**空库全链跑绿**（`docs/plans/03` §十：60 表零警告 / `0003` 17 PASS 0 FAIL / 守卫破坏测试拦停 / 两遍幂等）；order/send-order 回填演练通过；finance 段 `0016~0018` 回填/校验同日跑绿（994,279 分录 / 29 PASS 0 FAIL / 两遍金额全等）。
**交 DBA 前两条时序前置**：① T1 当天重跑 `precheck-username-duplicate.sql`，把新重名组补进 `_t1_username_fix`（正本是 `0002` §1 的字面量，改字面量并提交；手工插表会被下次执行抹掉）；② 生产侧复跑新表名重名核查（本机只覆盖 160/174）。T0 顺序：`0001 → 0001a → 0015 → 0002 → 0002a → 0003`。

**M0 基建进度（2026-10-16 当日追加，R1 启动）**：✅ **M0.1** legacy introspect 落地——活跃 schema `packages/db/prisma/schema.prisma` = **生产 PolarDB `taotaro`（MySQL 8.0.18）179 模型**（跳板机隧道 + gouba007 只读；`dg_mail1` 是视图无模型；21 张 deprecated 原样入模；生产 `dg_users` 75 列/22,628 行，dump 仅 5,021）；60 模型封存 `prisma/redesign/`；**双 generator 双 client** `src/generated/{legacy,redesign}`（`legacyPrisma`/`redesignPrisma` 单例，冒烟双过）；`pull:legacy` = pull + `post-pull-fixup.mjs`（数字前缀撞名修复 + **头部自愈**——`db pull` 会冲掉头部，正本 `prisma/legacy-header.txt`）。✅ **M0.2/0.3**：11 域包 `packages/domains/*` + `packages/notify` 由 `scripts/scaffold-domains.mjs` 生成（禁手写同构样板）；repository = 唯一可 import `@crossbuy/db` 处；auth = Principal + TokenVerifier 抽象；**ESLint 边界规则**（DB 白名单 / 域间禁 import / contract 纯净）+ `scripts/boundary-probe.mjs` 破坏验证 5/5。⏳ 剩余：apps/api（Fastify）脚手架、180 表属主逐张映射（07 §三/§四；注意盘点 174 已滞后于生产 180）、vendor 冷备、部署管线、Vitest 基线。typecheck 28/28、build 22/22、lint 28/28。

**技能（`.workbuddy/skills/`，2026-10-17 自 Claude Code superpowers 生态引入适配）**：6 个 = verification-before-completion（声称完成/提交前必加载）、systematic-debugging（提修复方案前找根因）、test-driven-development（写手写业务规则前）、writing-plans（写多步计划）+ executing-plans（执行）+ finishing-a-development-branch（收尾）。用法表在 **AGENTS.md「技能」小节**；`node scripts/import-claude-skills.mjs` 重跑同步。★ **项目专属补丁的正本是该脚本的 `PROJECT_PATCHES`**——改技能内容改脚本，**绝不直接改 `.workbuddy/skills/` 下的文件**（import 脚本整目录覆写会静默冲掉，2026-10-17 实测冲掉过 TDD 的「生成器优先 vs TDD 只约束手写业务规则」裁定）。⚠ 本会话技能列表来自插件缓存，**项目级技能需重启会话才进可调用列表**（实测 Skill 工具报 not found），刷不出来时直接读 SKILL.md 即可。

**仓库卫生约定（用户要求，2026-10-17）**：`.gitignore` **整体忽略 `.workbuddy/*`**（`.genie` 应用文件 / 临时脚本 / 会话快照一律不入库），但**放行 `.workbuddy/memory/` 与 `.workbuddy/skills/`** 两个子目录。★ 这两个路径是**工具链固定**的（记忆系统写 `.workbuddy/memory/YYYY-MM-DD.md`、项目级技能读 `.workbuddy/skills/`）⇒ **不可为躲 .gitignore 把它们搬出 .workbuddy**，搬家等于让工具读不到。改 .gitignore 后必须用 `git check-ignore -v` 双向验证（该留的 KEEP / 该忽略的 IGNORED）+ 真造垃圾文件看 `git status` 看不见。详见 README §仓库卫生。

**工具链红线（2026-10-17 定）**：★ **Prisma 产物 `src/generated/**` 写在源码树**，turbo 缓存命中会跳过生成却仍报成功 ⇒ `generate` 必须进依赖图且 `cache:false`，由 `packages/db/turbo.json`（`extends:["//"]`）让 db 的 build/typecheck 都 `dependsOn:["^build","generate"]`（db 在最上游，`^build` 对它为空，故 build 过 ≠ typecheck 过——实测 build 23/23 绿而 typecheck 报 TS2307）；db 的 build 脚本内**不再**调 generate（省 7s×2），保留 `prebuild`/`pretypecheck` 给绕过 turbo 的 pnpm 直接调用兜底（**turbo 直接 exec 脚本内容，生命周期钩子不触发**，所以不重复）。★ **package.json 是严格 JSON 禁 `//` 注释**（turbo.json / tsconfig.json 支持 jsonc 是特例），加了会让 pnpm 报 `ELIFECYCLE` 且错误信息指向注释文字本身，极难定位。

## ★ 血泪坑（按代价排序）
1. **ODKU 只适用于「撞键 = 同一实体重复投递」**：业务属性型唯一键（如 username）撞键 = 两个实体，ODKU 会**静默整行覆盖**（实测吞 5 账号、清零 2 笔余额、零报错）⇒ 必须 fail-fast `SIGNAL` 中止；且唯一性判断要按**目标列** collation。
2. **校验脚本会造假绿**：`ROW_COUNT()` 在 `DEALLOCATE PREPARE` 后取会被重置为 0（审计 15 表全报 0 行）；`grep -c FAIL` 会把 SQL 字面量数进去。⇒ 用结果列精确统计（`awk -F'\t' '{print $NF}' | sort | uniq -c`），任何「0/空/无结果」都要第二独立来源交叉核对（`2>/dev/null` 也能把 `ERROR 2003` 吞成「0 行」）。**「跑绿」≠「守卫有效」**——守卫要主动破坏一次看它 `rc=1` 点名中止。
3. **TEMPORARY 表不能承载回填脚本的输入**（verify 另起会话看不见）⇒ 升为实体暂存表；校验 expected 一律按当前源 + 映射实时算，**禁写死生产快照数字**。
4. 带 `member` 必需关系的表回填必须 `JOIN member` 过滤外键孤儿（实测 favorite 240 / browse 3389 / benefit 3 / log 68 / oauth_login 全表即孤儿），期望值同步改成「源中非孤儿数」。
5. `dg_users` 有 id 空洞（max 25,289 / 实 22,612）⇒ 顶自增用 `MAX(id)+1`，不是行数。
6. 口径清扫时**非金额列不能跟着盲替换**：`float_rate`/`order_weight`/`low_multiple` 不是钱；`v2_ecommerce_shop.currency`/`v2_ai_task.cost_currency` 是外部平台自己的结算币种。
7. 已演练通过的列定义别顺手改（给暂存表加 COLLATE 会让 mb3/mb4 混排路径偏离已验证版本）。

## 旧系统继承的结论（重写必须规避）
- **旧系统零对账**：`app/` 里没有任何「Σ流水=余额」校验；实测 `dg_record` 链断 **7.3%（36,482 环）/ 55% 会员**，断点 98.6% 在下单扣款，但期末余额 673/676 相符 ⇒ 只保最终余额、不保可追溯 ⇒ 新系统对账必须**逐环校验**。~~唯一真对账实现 = WorldFirst（`v2_worldfirst_*` 四表本地与 dump 都不存在，是否在产待核）~~ ⇒ **2026-10-16 生产实测结案：五表真实存在但全部 0 行**（trade_order / collection_statement / statement_recharge / notify / attachment）——空壳死表，对账从零建、无历史包袱（#11e⑥/Q13 关闭）。
- 旧「幂等列」不可信：`dg_record.idempotency_key` 是 DBA 手工加列（实测全 NULL、全仓零读写）；在用的 `sn` 生成含随机数；判重全是「先查后插」文本匹配 ⇒ 新系统幂等 = 唯一键 + 命令侧算 key + 非 NULL 率断言。
- 后门/裸奔：`skip_price_check`、`BatchUpdateOrder` 改价、`dg_rechargerecord` 后台可改 money/state/汇率反算、`dg_huilv` 全字段可手改、PayPal 回调仅 2 秒 `Cache::lock`、月费/仓储费 Job 无锁可扣成负、**充值「初审通过即入账」（银行流水核对在后）**。
- 领域硬伤：`bargainprice` 在 Order/SendOrder 语义不同、`goodsprice` vs `goodsprice1`、各域 status 独立状态机不可跨域假设。
- 金额精度乱：`dg_users.money` decimal(10,2) 实测 max 99,999,350.04（距上限 65 元 = 溢出风险）；`dg_huilv.huilv` float(10,2)。
- 山景 6 个 `shanjing/*` 私有包无主（`vendor/` 未入 git，`laravel-admin` 是后台骨架）⇒ 处置已定（2026-10-16）：~~fork 续命~~ 作废，**PHP 全面冻结 + vendor 只读冷备**（外包仅 bugfix 止血 + 契约变更登记制）。
- 关键发现：会员主表是 `dg_users`（v2_ 无会员主表）；`v2_address`/`v2_area` 是行政区划字典（非收货地址）；客户余额流水是 `dg_record`（type 方向 + action 原因 + accountmoney 快照），`finance_order_cash_flow` 是「财务代付动作」流水（`paid_money = price − bargain + send_price`，不含服务费）。
- 团队：2-3 名 Java 背景员工接管，兼职张（现主力）将离开 ⇒ 知识盘点是重写前置（TODO #2）。`own/` 下 `agent`/`ec-erp`/`system-kit` 是个人项目，勿动。
