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
- **已定参数（2026-10-13）**：余额 = **JPY + `Decimal(12,2)`**，跨币种靠 `balance_currency` 隔离、禁跨币种直接加减；`username` 上 **UNIQUE**。⚠ **2026-10-15 该拍板已被实测推翻并改判**：旧库对客全链路（`dg_order.goodsprice`／`dg_users.money`／`dg_record.money`／`dg_sendorder.totalfee`）面值都是 **CNY**，只有 `dg_rechargerecord.amount` 与 `dg_users.monpayamt` 是 JPY；按 JPY 回填 CNY 数值会静默放大 ~22 倍并让同库双写无法比对。**Q1 已拍板 = CNY；Q8 已拍板 = 金额 `Decimal(14,2)`、汇率 `Decimal(12,8)`**（原 12,2/12,4 混写废止，`docs/07 §6.2` 与 `utils/money.ts` 注释本轮已同步）。⇒ 今后对客金额注释**禁写 JPY**，真实维度是「对客价 vs 采购成本价」；清扫清单见 `docs/plans/finance-schema.md` §4.14 与 TODO **#11b**，**必须赶在 T0 落生产前做完**（否则回头就是 ALTER + 三域回填重跑）。
- **Q4 查重已跑（2026-10-13，旧库只读）**：22,611 用户中 **8 组 / 16 账号**重名；除 uid 4109（¥291.02/107 单）外全零订单。明细与消歧见 `docs/plans/02-用户名重名处置.md`，复现见 `packages/db/sql/disambiguate-username-proposal.sql`。
- **Collation 坑（2026-10-13 修正，极重要）**：旧库 `utf8_general_ci`（ci + **尾空格不敏感**）；新表 T0 生成的表级默认是 `utf8mb4_unicode_ci`，**两者口径不等价** —— 实测 22,612 真实用户名下重名组数：`utf8mb4_general_ci`=**8**、`utf8mb4_unicode_ci`=**24**、`0900_ai_ci`=23、`bin`=8。`unicode_ci` 额外把「全角/半角」「片假名/平假名」「全角空格 U+3000」视为等价，多出的 16 组里**有多对是不同人**（`RYUJI` uid1801 渡辺様 815 单 vs uid7874 深澤竜二 2 单）。→ **`member.username` 必须显式 `utf8mb4_general_ci`**（`packages/db/sql/0001a-member-username-collation.sql`；Prisma 不支持列级 collation，只能 raw SQL `MODIFY`）。副作用：username 与其他 `unicode_ci` 列混用会报 Illegal mix of collations → **禁与其他字符串列 JOIN/UNION**。判尾空格**禁用** `uname = TRIM(uname)`（ci 下 `'a '='a'` 真），必须比 `CHAR_LENGTH`。email **不加唯一**（`123456@qq.com` ×31 为测试号）。
- **生产库只读通道**：跳板机 `114.215.206.28` + SSH 端口转发 `-L 13306:<polardb>:3306` → PolarDB `taotaro`（MySQL 8.0.18）；本机 PHP CLI（FlyEnv 8.4）作 PDO 客户端。密码不入代码/文档，放独立文件（当前 `C:/Users/13621/.taotaro-db.pass`）。
- **⚠ 生产账号 `datapro` 只读**：`SHOW GRANTS` 仅有 `SELECT, INDEX, LOCK TABLES, SHOW VIEW`（+ 全局 PROCESS/REPLICATION/SHOW VIEW），**无 CREATE/INSERT/ALTER/DROP** → T0 建表 / T1 回填**必须由 DBA 用写账号执行**，我方只能提供脚本。
- **本地演练环境**：FlyEnv **MySQL 9.7.2**（`/d/Program Files/FlyEnv-Data/app/mysql-9.7.2/mysql-9.7.2-winx64/bin/mysql.exe`，127.0.0.1:3306，root/root），库 `crossbuy_dryrun`。注意该版本**无 `MD5()` 函数**；`ALTER TABLE ... AUTO_INCREMENT=(子查询)` 不被支持（用 `PREPARE`）；utf8mb3 字符串套 `utf8mb4_*` collation 需先 `CONVERT(... USING utf8mb4)`。
- **列名约定**：一律 snake_case。Prisma 默认用字段名当列名 → **每个多词字段必须 `@map("snake_case")`**（否则生成 camelCase 列）。
- **DDL 段基线重生成法（2026-10-15 验证可复用，含插段场景）**：重生成增量子脚本时用 `head -<上一段结束的下一个空行>` 截基线（首段 `--from-empty`，其余 `--from-schema-datamodel <基线> --to-schema-datamodel <下一版> --script`），截点必须落在「上一个模型 `}` 之后的空行」。⚠ **`--to-schema-datamodel` 禁指整份 schema**（会一次吐全部表）；**段与段之间插入新段时，后续所有段都要重基线**——`git show HEAD:` 当 from 的老写法在插段场景下会把新段算进 diff。判据：**未改动的段重生成后 `git diff` 必须为空**（finance 段插入后 `0002-order`/`0003-send-order` 逐字节不变）。改 schema 后必须重生成，**禁手改 DDL**；重生成后在临时空库跑 DDL 链验证 collation 补充脚本的成果没被冲掉（`member.username` + 4 个 `tid` 应仍 `utf8mb4_general_ci`），验证完 drop 临时库。四段现状：`0001` member 16 → `0015` finance 12 → `0002` order 26 → `0003` send-order 6 = **60 表**（全局序号只增不复用，`0002`/`0003` 前缀曾被两个家族各用一次，勿再新增第三个）。
- **口径清扫时「非金额列」不能跟着盲替换**（2026-10-15 实坑）：`member.float_rate`、`invoices.order_weight`、`invoices.low_multiple` 都是 `decimal(10,2)` 但**不是钱**；`0011` 里 `CAST(countweight AS DECIMAL(12,4))*1000` 是千克→克所需精度；`v2_ecommerce_shop.currency default('JPY')` / `v2_ai_task.cost_currency` 是**外部平台/服务商自己的结算币种**，与本系统账本面值（CNY）无关。批量替换前必须先按列义分类。
- **T1 回填脚本（2026-10-13 完成，本地演练 40 项断言全 PASS、3 遍幂等）**：`packages/db/sql/` 下 6 个脚本按 ①`0001` 建表 → ②`0001a` username collation → ③`0002` 核心三表回填 → ④`0003` 核心校验 → ⑤`0004` 13 张侧表回填 → ⑥`0005` 侧表校验。均 `INSERT..SELECT..ON DUPLICATE KEY UPDATE`（保留源 id）+ `PREPARE` 顶 AUTO_INCREMENT。
- **回填两铁律（2026-10-13，2026-10-15 补齐 member_address）**：① **带 `member` 必需关系的表必须 `JOIN member` 过滤外键孤儿**（否则 Prisma `include` 报错），实测孤儿 favorite 240 / browse 3389 / benefit 3 / log 68、oauth_login 唯一行即孤儿（回填 0）；`member_address` 曾漏掉这条（本地悬空 2 行），已补；代价是校验期望值要同步改成「源中非孤儿数」，且分批跑时地址段依赖会员段进度。② `dg_users` 有 id 空洞（max uid 25,289 / 实 22,612）→ 顶自增用 `MAX(id)+1` 不能用行数。
- **★ TEMPORARY 表不能承载「回填脚本的输入」（2026-10-15，#3g 根因）**：临时表只对创建会话可见，verify 脚本天然另起会话 → 旧版 `0003` 只能把消歧映射**再抄一遍字面量**（第二份真相，必然漂移），期望值也只好写死生产快照数字，换一份源就报 4 项无谓 FAIL、校验绿灯失去意义。⇒ 映射升为实体暂存表 `_t1_username_fix` / `_t1_username_merge`（`0002` §1 DROP+CREATE，字面量仍以脚本/git 为正本，表作审计），**校验的 expected 一律按当前源 + 映射表实时计算**，快照数字只留 INFO 观察项。凡「verify 要读 backfill 的输入」都适用这条。
- **★ 已演练通过的列定义别顺手改**：给 `_t1_username_fix.new_username` 加 `COLLATE utf8mb4_general_ci` 会让 `0002` 里 `COALESCE(f.new_username, NULLIF(TRIM(u.uname),''), ...)` 的 mb3/mb4 混排路径偏离跑通过的版本 → 撤回，改由只读校验脚本自己显式 `CAST(...) COLLATE ...`。
- **本机 `taotaro` 是旧版 dump**：`dg_users` 只有 **74 列**，生产实有 **75 列**（多 `biz_code`）。演练脚本（`0014`/`0006`）用 `information_schema.COLUMNS` 探测 + `PREPARE` 补列（留 NULL 压测 `0002` 的 `COALESCE(NULLIF(...))` 兜底），**生产不需要这类守卫**。语法坑：**`DO` 不在 prepared statement 白名单**，PREPARE 的 no-op 分支要用 `SELECT '...' AS note`。
- **★ 唯一键 ODKU 的实体边界（2026-10-15 演练实锤，最重要的一个坑）**：`INSERT..ON DUPLICATE KEY UPDATE` 只在「撞键 = 同一实体重复投递」时才正确。`member.username` 是 UNIQUE，未进 `_fix` 映射的重名对第二行撞键后会**把前一个账号的整行覆盖**（含 `balance`），本地实测吞掉 5 个账号、清零 2 笔余额且**零报错**。⇒ 业务属性型 UNIQUE 撞键必须 **fail-fast 中止**（`0002` 已加守卫 `_guard_username_disambiguated`），禁 upsert 覆盖；且**唯一性判断要按目标列 collation**：源 `dg_users.uname` 是 `utf8mb3_general_ci`（折叠平假名/片假名），目标 `member.username` 是 `utf8mb4_general_ci`（不折叠），按源判会误中止。**T1 执行前必须重跑 `precheck-username-duplicate.sql` 把新重名组补进映射表 `_t1_username_fix`**（Q4 是 2026-10-13 快照；「补」= 改 `0002` §1 的字面量并走一次提交，脚本会 DROP+CREATE 重建该表，手工往表里插行会被下一次执行抹掉）。
- **★ 校验脚本自己也会造假绿（2026-10-16 复跑实锤，两类）**：① **数字全零**——`PREPARE/EXECUTE` 之后若在 `DEALLOCATE PREPARE` **后面**取 `ROW_COUNT()`，会被 DEALLOCATE 重置成 0，搬运审计 15 张表全报 0 行，看着像「导入成功但源表空」；采集点必须紧跟 `EXECUTE`。② **关键字计数**——`grep -c FAIL` 会把 SQL 源码里的字面量 `IF(..., ''PASS'', ''FAIL'')` 数进去，曾把 0 FAIL 报成 1。⇒ 判定用结果列精确统计（`awk -F'\t' '{print $NF}' | sort | uniq -c`），且任何「0/空/无结果」都要有第二个独立来源交叉核对。同理：「跑绿」≠「守卫有效」，守卫要**主动破坏一次**（删映射行 / 用旧快照映射跑新快照）看它是否 `rc=1` 中止并点名。
- **演练脚本必须真在空库跑一遍**：`0014` 纸面上写「15 张旧源表」，实际本机 `taotaro` dump **缺 4 张 member 侧表**（`v2_member_webhook*` / `user_benefit*`，只存在于手工副本 `crossbuy_dryrun`）→ `CREATE TABLE LIKE taotaro.x` 直接 `ERROR 1146`。⇒ 改为**逐表择优取源** + `_drill_import_log` 审计来源/行数 + `_drill_safety_guard`（`DATABASE()` 落在源库里就 SIGNAL，因为脚本会 DROP 目标表；也别在 `crossbuy_dryrun` 里原地跑 `0014`，它是第 2 数据源）。
- **旧库「幂等列」三例不可信（2026-10-15 确证）**：① `dg_record.idempotency_key` UNIQUE 是 **DBA 手工加列**（无 migration、全仓零读写、实测全 NULL），别当「旧系统已验证实践」引用；② 真正在用的 `dg_record↔dg_rechargerecord` JOIN 键是 `sn`，但生成规则 `date("YmdHis").random_int(100,999)` **含随机数 = 非幂等**；③ 现存判重全是「先查后插」文本匹配（`remark LIKE '月会員費'`+当月窗、`hasBargainRefundRecord()`）。`dg_rechargerecord.gateway_transaction_no` UNIQUE 同样 PHP 侧零引用（只有 Stripe doc 规定 Python 服务写）。⇒ 新系统幂等必须「唯一键 + 命令侧算 key」，并配**非 NULL 率断言**。
- **账本分录表是「主键对齐旧 id」铁律的例外**：`dg_record`(8,073,550) 与 `dg_record_old`(5,987,115) **rid 各自自增、数值空间重叠**，合并进 `ledger_entries` 必撞号 ⇒ 分录 id 新分配，用 `(legacy_source, legacy_id)` 唯一键承载对齐。单据表（`recharge_orders.id=dg_rechargerecord.rid`）仍照铁律对齐。
- **PAT 取舍（T2 需复决）**：`v2_personal_access_tokens` 只回填 `App\Models\User` 且父会员存在（105,808 / 共 106,368）；排除 `AdminUser` 539（非会员域）。SQL 里写 `'App\\Models\\User'`（**双反斜杠**，否则 MySQL 吃 `\M`）。
- **字典表**：`area`（旧 `v2_area`，1940 行 JP 行政区划）随 member 试水先行落位，后续可移入 common/geo 域。
- **两个「第 4 个域落地时才浮现」的坑（2026-10-15，finance 段）**：① **含可空列的 `@@unique` 在 MySQL 里对 NULL 不去重** → `Account(kind, memberId)` 里 `memberId IS NULL` 的 COMPANY/PURCHASE/FREIGHT 等可以插多条同 kind，唯一性形同虚设（要 sentinel / 改键 / 靠应用层单写者，登记 TODO **#11c②**，草案语义本轮未擅改）；② **新表第一次不带域前缀时，重名核查要重做**——`docs/plans/00` 的 174 张盘点按六个前缀（`dg_`/`v2_`/`admin_`/`sys_`/`deprecated_`/`relation_`）分组，「前缀家族不撞」**推不出**「不存在同名裸表」（`accounts` 风险最高；前三域带域前缀是从没可能撞，不是查过）→ 核查 SQL 见 `finance-schema.md` §九-⑦，登记 **#11c①**，T0 落库前必跑。

## 数据模型参考（docs/plans）
- `00-旧库表结构盘点.md`：174 张旧表按代际分组（dg_ 71 / v2_ 44 / deprecated_ 21 / admin_ 12 / sys_ 11 / 其他）
- `01-v2表字段精读.md`：44 张 v2_ + `finance_order_cash_flow` 字段级精读（唯一键/状态枚举/坑）
- 关键发现：`v2_address`/`v2_area` 是**行政区划字典**（非收货地址）；会员主表是 `dg_users`（v2_ 无会员主表）；`finance_order_cash_flow` **不是会员余额流水也不是订单行**——它是「财务代付动作」流水（`paid_money = price − bargain + send_price`，实测 100% 成立，不含服务费，带后台 operator）；**客户余额流水是 `dg_record`**（807 万行，`type` 收支方向 + `action` 业务原因 + `accountmoney` 动账后快照）。
- `finance-schema.md`（2026-10-15 底稿 + **schema 已落地**）：finance 域 4 表列级精读 + `action`/`state`/`paytype` 全量词表 + 账本链断实测 + **12 模型已进 `schema.prisma`**（§五 9 个 + 告警双表 + 镜像水位；与草案的 6 处 delta 回写 **§5.1**）+ Q1~Q14。**Finance 并非 0 篇文档**：`backend/docs/business/` 实为 67 篇、finance 相关 4 篇（旧记载「80 篇 / Finance 0 篇」已订正）。
- 金额精度不统一（DECIMAL(10,2)/(12,2)/float/varchar「价格+币种」）；`v2_order_detail.coupon_fee` 是 float；`dg_users.money` 是 **decimal(10,2)**（实测 max 99,999,350.04，距上限仅 64.95 元 = 溢出风险）；`dg_huilv.huilv` 是 **float(10,2)**（对 0.045 量级只剩 2 位有效数字）。

## 迁移顺序（价值 × 知识沉淀）
先续命（fork 山景私有包 + 兼职张知识盘点）→ member 开放 API 试水（文档最全）→ order/send-order → finance（含对账）→ logistics/ticket/cms。前台 www 灰度替换（SEO 不能断收录）。

## 从旧系统继承的关键结论（重写时必须规避的坑）
- **领域模型硬伤**（AGENTS.md 自曝）：`bargainprice` 在 Order/SendOrder 语义不同；`goodsprice` vs `goodsprice1`（原价/砍后价）；各域 `status` 独立状态机不可跨域假设
- **对账体系缺失（2026-10-15 已量化）**：旧 `app/` 里**没有任何「Σ流水=余额」校验**；实测 `dg_record` 链断 **7.3%（36,482 环）、55% 会员受影响**、断点 98.6% 在下单扣款，而期末余额 673/676 仍相符 ⇒ 旧系统只保最终余额不保每笔可追溯，**对账必须逐环校验**。后门 `skip_price_check`、`BatchUpdateOrder` 可改金额、`dg_rechargerecord` 后台可改 `money`/汇率反算、`dg_huilv` 全字段可手改、PayPal 回调仅 2 秒 `Cache::lock`+先查后改、月费/仓储费 Job 无锁无校验。★ **唯一一处真对账实现 = WorldFirst**（`MatchWorldFirstCollectionStatementsService` 循环扣减+容差+不足标记），但其 `v2_worldfirst_*` 四表在生产 dump 与本地副本都不存在（是否在产待核）。⇒ 新系统必须内置对账，并可复用 WorldFirst 的匹配范式。
- **山景私有包无主**：6 个 `shanjing/*` 包分发渠道全在山景手里，`vendor/` 未入 git，`laravel-admin`(2634 文件) 是后台骨架 → 重写前必须 fork 续命（详见 `haiou/.workbuddy/memory/2026-10-12.md`）
- 领域边界（AGENTS.md）：Order · SendOrder · Finance · Logistics · Member/User · WMS · Ticket · Email

## 关键约定
- `own/` 下的 `agent`、`ec-erp`、`system-kit` 是用户**个人项目，勿动**
- 业务文档 80 篇在 `backend/docs/business/`；架构分层规则在 `backend/AGENTS.md`
- 团队：2-3 名 Java 背景正式员工接管，兼职张（当前主力）将离开 → 知识盘点是重写前置条件
