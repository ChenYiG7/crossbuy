# packages/db/sql —— 迁移 SQL

本目录存放**手工可控**的迁移 SQL。生产旧库（`taotaro`）是**只读参考**：这里的脚本只写**新表**，绝不回写旧表。

## 文件与执行顺序

| # | 文件 | 用途 | 读写 | 阶段 |
|---|---|---|---|---|
| — | `precheck-username-duplicate.sql` | `dg_users.uname` 重名核查 | 只读 | 前置 |
| — | `disambiguate-username-proposal.sql` | 重名账号「保留/改名」建议 | 只读 | 前置 |
| ① | `0001-member-domain-up.sql` | 建 17 张新表（**由 schema.prisma 生成，勿手改**） | 建表 | T0 |
| ② | `0001a-member-username-collation.sql` | 把 `member.username` 排序规则定为 `utf8mb4_general_ci`（**手工 SQL**） | ALTER | T0 |
| ③ | `0002-member-backfill-t1.sql` | 建消歧映射表 `_t1_username_fix`/`_t1_username_merge` + **重名 fail-fast 守卫** + 回填 member 域**核心三表**（`member_address` 已加 `JOIN member` 过滤孤儿）+ 顶 AUTO_INCREMENT（幂等） | 写新表 | T1 |
| ④ | `0003-member-backfill-verify.sql` | 21 项断言（**期望值全部按当前源 + 映射表实时计算**，禁写死生产快照数字） | 只读 | T1 |
| ⑤ | `0004-member-backfill-t1-part2.sql` | 回填 **13 张侧表**（webhook/oauth/favorite/browse/benefit/log/area/PAT/idempotency） | 写新表 | T1 |
| ⑥ | `0005-member-backfill-verify-part2.sql` | 侧表行数 + 外键悬空 + id 保留断言 | 只读 | T1 |
| ⑦ | `0002-order-domain-up.sql` | 建 **26 张 order 域新表**（由 schema.prisma 增量 diff 生成，勿手改） | 建表 | T0 |
| ⑧ | `0002a-order-tid-collation.sql` | tid 家族 4 列统一 `utf8mb4_general_ci`（**手工 SQL**，Prisma 不支持列级 collation） | ALTER | T0 |
| ⑨ | `0006-order-source-import.sql` | **本地演练专用**：从本地 `taotaro` 副本导入 21 张 order 域旧表到 `crossbuy_dryrun` | 写旧表副本 | 演练 |
| ⑩ | `0007-order-backfill-t1.sql` | 回填**核心三件套**：`order_groups`（tid 建组）+ `orders`（oid 对齐分片存储过程）+ `order_status_histories`（幂等） | 写新表 | T1 |
| ⑪ | `0008-order-backfill-t1-part2.sql` | 回填 **19 张侧表**（shops/platform*/import/cart/message/examination/split/增值服务） | 写新表 | T1 |
| ⑫ | `0009-order-backfill-verify.sql` | 21 项断言（组数/砍价总额/逐组金额/孤儿/JSON/状态分布/自增） | 只读 | T1 |
| ⑬ | `0003-send-order-domain-up.sql` | 建 **6 张 send-order 域新表**（schema.prisma 增量 diff 生成，勿手改） | 建表 | T0 |
| ⑭ | `0010-send-order-source-import.sql` | **本地演练专用**：导入 `dg_sendorder` / `v2_sendorder_value_added_service` / `dg_fapiao`（sid 命中子集） | 写旧表副本 | 演练 |
| ⑮ | `0011-send-order-backfill-t1.sql` | 回填核心：`send_orders`（sid 对齐）+ `send_order_status_histories` + `orders.send_order_id` 单侧关联校正 | 写新表 | T1 |
| ⑯ | `0012-send-order-backfill-t1-part2.sql` | 回填侧表：`send_order_value_added_services` / `invoices`（29,238）+ labels/invoice_events（本地无源表 PREPARE 跳过） | 写新表 | T1 |
| ⑰ | `0013-send-order-backfill-verify.sql` | 18 项断言（sid 对齐/五费总额/保险独立/砍价/返金/sn 长度/发票/fid/悬空/状态分布/计费重/同捆/totalfee 禁回填） | 只读 | T1 |
| ⑱ | `0014-member-source-import.sql` | **本地演练专用**：导入 member 域 15 张旧源表（`dg_users`/`dg_address` + 13 张侧表源）到 `crossbuy_dryrun`，含 `biz_code` 补列守卫与行数自检 | 写旧表副本 | 演练 |

> ✅ 全流程已在**本地 MySQL 9.7.2** 用「生产 DDL + 无 PII 合成样本」演练通过（member 核心三表 15/15 PASS；侧表 25 项全 PASS；3 遍幂等；回退验证 OK），见 `docs/plans/03-T1本地演练报告.md`。
> ⚠ **#3g 硬化（2026-10-15）改动了 `0002`/`0003`/`0006` 并新增 `0014`，上述「15/15」是改造前的计数**；新版 `0003` 为 21 项断言（组 A 7 + 组 B 14），改造后的 T1 复跑**尚未执行**（本机 MySQL 需口令，见 TODO #3g 验证清单）。
>
> ⚠️ **生产写权限阻塞**：生产账号 `datapro` 仅有 `SELECT, INDEX, LOCK TABLES, SHOW VIEW`（`taotaro.*`），**无 CREATE/INSERT/ALTER/DROP**。①~⑤ 需由 DBA 用具备 DDL/DML 的账号执行。

## 第二批侧表回填要点（⑤ `0004`）

字段来源为**线上 `information_schema` 实测**（122 列 / 13 表），与目标 schema 逐列同名（仅 `uid → member_id`）。三个关键决策：

1. **过滤外键孤儿**：带 `member` 必需关系的表一律 `JOIN member`，只回填父行存在的记录（否则 Prisma `include` 会因关系缺失报错）。实测孤儿：`favorite` 240、`browse_history` 3389、`member_benefit` 3、`member_operation_log` 68；`oauth_login` 唯一一行（uid 21095）即孤儿 → 回填 0 行。
2. **PAT 取舍**：仅回填 `App\Models\User` 且父会员存在的 **105,808** 条；排除 539 条 `App\Models\AdminUser`（非会员域）+ 21 条父会员已不存在的 User token。Sanctum token 为 sha256 单向哈希（明文不可恢复）→ 保留 = 老客户端继续可用；**若 T2 改鉴权方案可整表清空重发**。
3. **保留源 id**：`favorite` / `browse_history` / `personal_access_token` 等大表 id 保留（含 id 空洞），跨系统对账可对齐；故末尾必须顶 `AUTO_INCREMENT`。

实测回填量（源 → 目标）：`benefit_config` 2→2 · `member_benefit` 718→715 · `member_operation_log` 3086→3018 · `personal_access_token` 106368→105808 · `oauth_login` 1→0 · `oauth_taobao_global` 1→1 · `favorite` 183753→183513 · `favorite_category` 20→20 · `browse_history` 210051→206662 · `area` 1940→1940 · `member_webhook`/`delivery`/`open_api_idempotency` 0→0。

## 0001 的来源与再生成

`0001-member-domain-up.sql` 从**正本** `prisma/schema.prisma` 生成，保证零漂移：

```bash
cd packages/db
DATABASE_URL="mysql://u:p@localhost:3306/db" \
  ../../node_modules/.bin/prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  > sql/0001-member-domain-up.sql
```

> ⚠️ **改 schema 后必须重新生成**，禁手改本文件。正本是 schema.prisma。
> `0001a` 是**例外**：Prisma 不支持列级 collation，故为手工 SQL，不属于「手改生成的 DDL」。

## order 域回填要点（⑩ `0007` / ⑪ `0008`）

1. **Q5 拍板落地**：`order_groups` 按 tid 建组（`bargain_amount = SUM(bargainprice)`，口径无关）；空 tid 单独立成组（`legacy_order_id` = oid 作幂等键——tid 为 NULL 时 UNIQUE 不去重）。本地实测：26,078 组（tid 组 22,823 + 独立组 3,255），砍价总额 372,331.23 与源**分毫不差**（A3 断言）。
2. **暂存表必须 ANALYZE**：新建+插满的 InnoDB 表持久统计为空，相关子查询选错计划——本地实测组表 INSERT 从 290s+ 降到 2.2s。`_t1_valid_order` / `_t1_order_group`  populate 后紧跟 `ANALYZE TABLE`。
3. **tid collation 全家一致**：`order_groups.tid` 经 0002a 改 `general_ci` 后，暂存表 `_t1_valid_order.tid` 也须显式 `general_ci`，否则 JOIN 报 `ERROR 1267 Illegal mix of collations`（0002a 注释预告的坑，演练中实际踩到）。
4. **分片存储过程**：`_backfill_orders(batch_size)` 按 `oid > last ORDER BY oid LIMIT n` 逐批推进（oid 有空洞禁等分区间）；本地 73,291 行 / 批 20,000 跑 4 批共 6 秒；生产 587 万行建议批 50,000。
5. **组关联禁 OR 条件**：`g.tid=o.tid OR g.legacy_order_id=o.oid` 走不了索引（本地实测 10 分钟跑不完）——必须先建 `_t1_order_group` 映射表（两个分支各走 UNIQUE 索引 UNION），主查询只做 PK JOIN。
6. **本地演练实测量**（`taotaro` 副本 → `crossbuy_dryrun`）：orders 73,291/328,479（其余 78% 为 uid 孤儿，被 `JOIN member` 过滤——本地 `dg_users` 副本仅 5,021 行所致，非真实孤儿率）；21 项断言全 PASS；两遍重跑计数不变（幂等）。
7. **MySQL 语法坑**：`REGEXP_SUBSTR` 无第 6 个捕获组参数（MariaDB 语法）——补发序号改用 `SUBSTRING_INDEX(expressno,'_',-1)` + `REGEXP '_[0-9]+$'` 守卫。

## order 域 0002 DDL 的再生成

`0002-order-domain-up.sql` 是**增量** diff（只含 order 段，不动 member 表）：

```bash
cd packages/db
git show HEAD:packages/db/prisma/schema.prisma > /tmp/schema-before.prisma   # 改前版本
DATABASE_URL="mysql://u:p@localhost:3306/db" \
  node_modules/.bin/prisma migrate diff \
  --from-schema-datamodel /tmp/schema-before.prisma \
  --to-schema-datamodel prisma/schema.prisma --script \
  > sql/0002-order-domain-up.sql
```

> ⚠️ 改 schema 后必须重新生成，禁手改。`0002a` 同 `0001a` 是例外（列级 collation 只能 raw SQL）。

## send-order 域回填要点（⑮ `0011` / ⑯ `0012`）

1. **Q3 拍板落地**：`dg_fapiao` 归 send-order 域 → `invoices` 表（`id == fid`，29,238 行本地子集 / 生产 446 万按 fid 分片）；整表按「出货文件快照」建模，会员/收件人快照列保留，禁反查实时表。
2. **totalfee 禁信历史值**：旧系统双口径脏数据不回填 → `charged_total_fee` 一律 NULL（B16 断言），五费分列落库、业务读值服务端现算；保险费独立列（B5 对账口径）。
3. **oids 双写废除**：只存 `orders.send_order_id` 一侧；`0011 §3` 用 `LEFT JOIN send_orders` 修正 0007 的裸 CAST 残留（sid='0' 与悬空 sid → NULL，B3a/B3b 断言）；`dg_sendorder.oids` 仅校验禁作回填源。
4. **sn/airbill 多单号拆分**：`#` 连接的多运单号（本地 sn 最长 363 / airbill 最长 139）→ 首段入列（≤64 断言 B7），全量拆分 `{trackingNumbers:[...]}` 入 `snExtra`；`_t1_numbers` 序号表 + `JSON_ARRAYAGG` 实现拆分。
5. **类型修正**：`countweight` 十进制千克 → `ROUND(CAST(*1000))` 克（B13：2,804 行解析）；`mailremark` 双形态拆两列（B18：139 行带附件 / 1,412 行纯文本）；`mark_flag` 本地全 NULL 不拆包原样入列。
6. **bundledInto 悬空收口**：子运单有效但父运单被 member 过滤时（本地 4 例），`bundled_into_id` 置 NULL + 父 sid 留档 `legacy_extra.bundledIntoLegacySid`（B15 断言 0 悬空）。同捆纯组织关系禁金额 rollup（Q7）。
7. **PREPARE 条件回填**：`v2_send_order_label` / `v2_send_order_invoice_event` 本地无表 → `information_schema` 探测后条件执行，输出 SKIP 提示而非报错（生产有表自动回填）。
8. **本地演练实测量**（`taotaro` 副本 → `crossbuy_dryrun`）：send_orders 3,437/18,078（uid 孤儿被 JOIN member 过滤，本地 dg_users 副本仅 5,021 行所致）；invoices 29,238；vas 36；五费总额 3,066,980.18 与源分毫不差；18 项断言全 PASS；两遍重跑计数不变（幂等）。

## 0003 DDL 的再生成

`0003-send-order-domain-up.sql` 是**增量** diff（只含 send-order 段，不动既有表——`orders.send_order_id` 已在 0002 预留，diff 无 ALTER）：

```bash
cd packages/db
head -<send-order 段起始行-1> prisma/schema.prisma > /tmp/schema-before.prisma  # 截掉新段作基准
DATABASE_URL="mysql://u:p@localhost:3306/db" \
  node_modules/.bin/prisma migrate diff \
  --from-schema-datamodel /tmp/schema-before.prisma \
  --to-schema-datamodel prisma/schema.prisma --script \
  > sql/0003-send-order-domain-up.sql
```

> ⚠️ 改 schema 后必须重新生成，禁手改。send-order 段无列级 collation 需求（tid 家族不在本域），故无 0003a。

## 历史表幂等坑（0007/0011 通用，2026-10-15 修正）

**症状**：`*_status_histories` 重跑翻倍（order 73,291→146,582；send-order 3,437→10,311）。
**根因**：回填用 `INSERT ... ODKU`，但历史表**无唯一键**（语义上也不该建——真实迁移会重复 toStatus），且 `from_status = NULL` 在唯一索引里不去重 → ODKU 永不命中，每次重跑全量新插。
**修法**：改 `WHERE NOT EXISTS (SELECT 1 FROM ... WHERE send_order_id = o.id AND kind/reason = 'T1 backfill')` 守卫；已污染数据按实体保留最小 id 去重（dryrun 已清洗）。
**教训**：声称「幂等通过」前，**每一张**目标表都要比对计数——order 域首次只比了 orders/order_groups 漏掉历史表。

## 本机 mysql 客户端字符集坑（2026-10-15）

本机 mysql CLI 默认 gbk，脚本内含中文**字符串字面量**（如 `'dg_fapiao(子集)'`）会报 `ERROR 3854 Cannot convert string from gbk to gbk`。
**规避**：① 脚本内字面量一律 ASCII（已改）；② 跑校验脚本加 `--default-character-set=utf8mb4`。

## 口径变更后的复跑清单（2026-10-15，Q1 面值 CNY + Q8 金额 14,2）

改精度/币种时**容易漏的三类落点**（本轮全部踩到并已修）：

1. **列定义**：`schema.prisma` 的 `@db.Decimal(...)` 与 `@default("JPY")` → 重生成 `0001/0002/0003`。
2. **回填脚本里的类型转换**：`CAST(... AS DECIMAL(12, 2))` 共 4 处（`0007:251`、`0008:88/115/117`）——不改会把宽口径截回两位整数上限。
3. ★ **硬写的币种字面量**：`0002:95` / `0002:166`（`balance_currency`）、`0007:248`（`charged_currency`）三处 `'JPY'` → `'CNY'`。**这类只有跑演练才暴露**，静态扫 `schema.prisma` 完全看不见。

**不该跟着改的**（按列义判断，非按精度判断）：

| 位置 | 为什么保留 |
|---|---|
| `member.float_rate` `(10,2)` | Q3 判死列，处置未拍板 |
| `invoices.order_weight` `(10,2)`、`invoices.low_multiple` `(10,2)` | 重量与倍率，**不是金额** |
| `0011` 的 `CAST(countweight AS DECIMAL(12,4)) * 1000` | 千克→克，需要 4 位小数 |
| `shops.currency` DEFAULT `'JPY'`（= `0002` DDL 内那条） | **外部平台店铺自己的结算币种**（`v2_ecommerce_shop`），与本系统账本面值无关；`0008` 对 `v2_ecommerce_order.price`「2999 JPY」的拆分同理 |

**静态验证已做**（临时空库 `crossbuy_ddlcheck`，跑 `0001 → 0001a → 0002 → 0002a → 0003`）：49 表建成、`decimal(14,2)`×65、`decimal(12,8)`×1、`decimal(10,2)`×3（即上表保留项）、`balance_currency`/`charged_currency` 默认值实测 CNY、`member.username` + 4 个 `tid` 仍 `utf8mb4_general_ci`。

**空库起跑的两个前置缺口**（本机 MySQL 停机后暴露；**2026-10-15 已闭合，见 ⑱**）：

1. ✅ **member 域旧源表没有导入脚本** → 已补 `0014-member-source-import.sql`（15 张表 + 行数自检）。前几轮演练是在 `crossbuy_dryrun` 里**手工**建旧表副本，库一旦重建，③⑤ 就无从起跑。
2. ✅ **`0006` 曾假定目标库里已有 `dg_users`**（只 `TRUNCATE` 不建表 → 新库跑报 `Table doesn't exist`）→ 已改 `CREATE TABLE IF NOT EXISTS ... LIKE taotaro.dg_users` + 补列守卫，`0006` 可独立起跑。

> ★ **本机 `taotaro` 是旧版 dump**：`dg_users` 只有 **74 列**，生产实为 **75 列**（多 `biz_code`，2026-10-13 按线上 `information_schema` 核对）。`0014`/`0006` 都用 `information_schema` 探测后 `ALTER ... ADD COLUMN biz_code VARCHAR(56) NULL` 补齐，**留 NULL 正好压测 `0002` 的 `COALESCE(NULLIF(...))` 兜底路径**。这两条守卫是「本机 dump 落后于生产」的补丁，**生产不需要**。

## 2026-10-15 定版后复跑（Q1 CNY + Q8 14,2）：全链绿，并加了一道 fail-fast

- 复跑范围：重建 49 张派生表 → `0006`/`0010` 刷新源 → `0002`/`0004`（member）→ `0007`/`0008`（order）→ `0011`/`0012`（send-order）→ 四份 verify → **第二遍计数与金额完全不变**。金额证据：Σ`member.balance` = Σ`dg_users.money` = 115,263,758.22；Σ`order_groups.bargain_amount` = 364,598.62；五费 3,050,486.56；历史表行数 = 实体数（无翻倍）。详见 `docs/plans/03-T1本地演练报告.md` §九。
- ★★ **`0002` 守卫 `_guard_username_disambiguated`（必留在 §2 之前）**：未进消歧映射的重名对会让 `INSERT..ODKU` **把后一个账号的整行盖到前一个账号身上**（本地实测吞掉 5 个账号、清零 2 个余额，零报错）。守卫按**目标列 collation**（`utf8mb4_general_ci`）判碰撞后 `SIGNAL` 中止，并把撞车名（最多 200 字符）打进报错文本供 DBA 直接定位。⇒ **T1 前必须重跑 `precheck-username-duplicate.sql` 补 `_t1_username_fix`**；不补就是中止而不是「假成功」。
- ⚠ collation 新坑：源 `dg_users.uname` 是 `utf8mb3_general_ci`（**折叠平假名/片假名**），目标 `member.username` 是 `utf8mb4_general_ci`（**不折叠**）→ 唯一性判断/守卫/断言一律 `CAST(... AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_general_ci`，按源 collation 判会误中止。

## #3g 硬化（2026-10-15，复跑暴露的三条）

| # | 缺陷 | 修法 | 影响面 |
|---|---|---|---|
| ② | `0003` 的 A1/A3/B6/B7 把**生产快照数字**（8 组 / 8 改名 / 1 合并）写死成 expected → 换任何一份源必然无谓 FAIL，「校验绿灯」失去意义 | 期望值**改为按当前源 + 映射表实时计算**；映射由 TEMPORARY 升为实体表 `_t1_username_fix`/`_t1_username_merge`（`0002` §1 建、保留作审计），`0003` 跨会话读它 ⇒ 脚本与校验**读同一份映射**，源变了期望值自动跟着变 | `0002` §1、`0003` 组 A/B 全量重写（新增 A3 映射陈旧、A4 改名规则、A5 合并端悬空、B13 孤儿地址 INFO、B14 映射落库核对） |
| ③ | `member_address` 回填**没有 `JOIN member` 过滤孤儿**（本地 B12 悬空 2 行）→ 生产会产生悬空 `member_id`，Prisma 必需关系 `include` 直接报错 | `0002` §4 加 `JOIN member m ON m.id = a.uid`；`0003` 的 B2 期望值同步改为「源中非孤儿地址数」，B12 从 INF/WARN 升级为硬 PASS，新增 B13 INFO 暴露被过滤的数量 | 分批时须注意 §4 依赖 §2 进度（见 `0002` §7 新注释）：按 uid 升序推进，全批跑完再复跑一次 §4 |
| ④ | member 域旧源表**只能手工复现**；`0006` 又假定 `dg_users` 已存在 | 新增 `0014-member-source-import.sql`（15 表 + 行数自检）；`0006` §0 改自愈化（`CREATE TABLE IF NOT EXISTS` + 补列守卫） | 空库可从零复跑：`0001 → 0001a → 0014 → 0002 → 0003 → 0004 → 0005` |

> ★ **升实体表的真正理由不是「方便」**：临时表**只对创建它的会话可见**，而 verify 脚本天然另起会话 → 旧版 `0003` 只能把 8 行映射**再抄一遍字面量**。那就是第二份真相，必然与正本漂移。任何「校验脚本要读回填脚本的输入」的场景，都禁用 TEMPORARY 表承载那份输入。
>
> ⚠ `0003` 现在依赖映射表存在：若目标库被重建而没重跑 `0002`，`0003` 会在 A2 报 `table doesn't exist` —— 这是**预期**（等于说「回填还没跑」），别把它当校验脚本的 bug。

## 执行注意

1. **只对新表**：DDL 只建 `member*`、`favorite*`、`oauth_*`、`open_api_idempotency`、`browse_history`、`benefit*`、`area`、`ledger_entry`——全部新表名，**与旧库 174 张无重名**（已核查）。
2. **不改旧表**：对 `dg_users`/`dg_address`/`v2_*` **不做任何变更**。
3. **collation 必须先定（②）**：否则 `member.username` 会继承表级默认 `utf8mb4_unicode_ci`，重名口径从 8 组变 **24 组**，回填会失败（多出的 16 组含**不同人**）。详见 `docs/plans/03` §五。
4. **AUTO_INCREMENT 需顶高**（已内置于 ③）：回填后设为 `max(uid)+1`，否则新记录撞旧 id。注意 MySQL **不允许** `ALTER TABLE ... AUTO_INCREMENT = (子查询)`，脚本用 `PREPARE` 绕过。
5. **幂等**：③ 可反复执行（`INSERT ... SELECT ... ON DUPLICATE KEY UPDATE`）。旧库在回填期间仍在写入（实测 `dg_users` 22,611→22,612），必须可分批复跑。
6. **username 唯一约束的障碍在回填**：8 组 / 16 账号必须先消歧（③ 已内嵌映射）。
7. **不用 DB 端 `MD5()`**：本机 MySQL 9.7.2 无该函数；密码哈希由应用层（argon2）产生。

## 回退

全部为纯新增，回退 = `DROP` 新建的那批表即可，旧表与旧数据不受影响（本地已验证）。
派生表之外还有两张**回填期暂存表**要一并 DROP：`_t1_username_fix`、`_t1_username_merge`（member），`_t1_valid_order`、`_t1_order_group`（order）——它们不在 `schema.prisma` 里，`0001`/`0002` DDL 不会生成也不会删除。

## 复跑验证命令（改 `0002`/`0003`/`0014` 后必跑）

口令**不进命令行、不进仓库**：用 `-p`（交互提示）或 `MYSQL_PWD` 由操作者本机注入。

```bash
# 本机 FlyEnv mysql CLI（9.7.2）；客户端默认 gbk，校验脚本必须显式 utf8mb4
M="/d/Program Files/FlyEnv-Data/app/mysql-9.7.2/mysql-9.7.2-winx64/bin/mysql"
DB=crossbuy_dryrun
D() { "$M" -h 127.0.0.1 -P 3306 -u root -p --default-character-set=utf8mb4 -D "$DB" < "$1"; }

# 空库全链（演练库可从零复现，#3g④ 之后）
#   建库：CREATE DATABASE crossbuy_dryrun;
cd packages/db/sql
D 0001-member-domain-up.sql        # ① 建 17 张新表
D 0001a-member-username-collation.sql  # ② collation 定版（必须先于回填）
D 0014-member-source-import.sql    # ⑱ 旧源表落地（含 biz_code 补列守卫）
D 0002-member-backfill-t1.sql      # ③ 映射表 + 守卫 + 核心三表
D 0003-member-backfill-verify.sql  # ④ 21 项断言：result 列必须全 PASS/INFO
D 0004-member-backfill-t1-part2.sql && D 0005-member-backfill-verify-part2.sql  # ⑤⑥ 侧表
# 幂等判定：③⑤ 各连跑两遍，比对**每一张**目标表计数（历史表最容易漏，见「历史表幂等坑」）
```

> ⚠ **别把空结果当事实**：`2>/dev/null` 会把 `ERROR 2003 Can't connect` 吞成「0 张表」，
> 曾据此误判「dryrun 是空库」。取证类查询**要么保留 stderr，要么二次确认**。

## 相关文档

- `docs/plans/03-T1本地演练报告.md` —— 演练证据 + collation 决策 + 映射修正
- `docs/plans/02-用户名重名处置.md` —— Q4 查重结果（8 组 16 账号）+ 消歧规则
- `docs/plans/member-迁移与共存.md` —— 完整时序（T0→T3）/ 字段映射 / 验收 / 风险
- `docs/plans/member-schema.md` —— member 域设计
