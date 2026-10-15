# member 域 schema 设计（试水）

> 依据：`docs/plans/01-v2表字段精读.md`、`docs/00-原项目参考指南.md`、`docs/07-开发规范守则.md`
> 目标：把 member 域作为**第一个垂直切片**，端到端定义 Prisma schema 正本草案。
> 状态：**草案**。Q7 已定：**新表为唯一正本**（不继承旧表结构）；其余未决项见第六节。
> 共存与切换：见 `docs/plans/member-迁移与共存.md`。

---

## 一、域边界

**member 域负责**：会员身份、认证、地址、平台账号绑定、收藏/浏览、权益、开放 API 的会员侧（webhook 配置 + 幂等键）、会员操作审计。

**member 域不负责**（跨域，通过 contract 调用，禁直接建库关联）：
- 余额的**记账**（归 finance：`ledger_entries`）——member 只持有余额**冗余列**
- 平台订单/店铺（归 order：`v2_ecommerce_shop` 是 order 域的 `Shop`）
- 采买子账号的**用**（`v2_platform_sub_account` 供 order 下单使用；member 域只做「账号池」的增删改查）

> 边界判定依据：`AGENTS.md`（Order · SendOrder · Finance · Logistics · Member/User · WMS · Ticket · Email）。

---

## 二、实体清单与源表映射

| # | 新实体（Prisma model） | 目标表名 | 源表 | 备注 |
|---|---|---|---|---|
| 1 | `Member` | `member` | `dg_users` | 会员根实体 |
| 2 | `MemberCompany` | `member_company` | `dg_users`（com* 组拆分） | 法人信息，1:1，仅 regtype=1 |
| 3 | `MemberAddress` | `member_address` | `dg_address` | type 1收货/2进口商 |
| 4 | `MemberWebhook` | `member_webhook` | `v2_member_webhook` | uid 唯一 |
| 5 | `MemberWebhookDelivery` | `member_webhook_delivery` | `v2_member_webhook_delivery` | event_key 唯一 |
| 6 | `PersonalAccessToken` | `personal_access_token` | `v2_personal_access_tokens` | 取代 dg_users.apitoken |
| 7 | `OauthLogin` | `oauth_login` | `v2_oauth_login` | |
| 8 | `OauthTaobaoGlobal` | `oauth_taobao_global` | `v2_oauth_taobao_global` | |
| 9 | `OpenApiIdempotency` | `open_api_idempotency` | `v2_open_api_idempotency` | 三列唯一 |
| 10 | `Favorite` | `favorite` | `v2_favorite` | |
| 11 | `FavoriteCategory` | `favorite_category` | `v2_favorite_category` | |
| 12 | `BrowseHistory` | `browse_history` | `v2_user_browse_history` | 高频写 |
| 13 | `BenefitConfig` | `benefit_config` | `user_benefit_configs` | |
| 14 | `MemberBenefit` | `member_benefit` | `user_benefits` | |
| 15 | `MemberOperationLog` | `member_operation_log` | `user_operation_log` | 审计 |
| 16 | `Area` | `area` | `v2_area`（弃 `v2_address`） | geo 字典，建议移入 `common` 域 |

> `v2_user_platform_account` / `v2_platform_sub_account`：**暂不建模**。前者与 order 域耦合（下单提交信息），后者是采买账号池——待 order 域再定，避免 member 域越界。

---

## 三、关键建模决策（逐条给理由）

### 3.1 金额：`money` 不是正本，是缓存

- 旧：`dg_users.money DECIMAL(10,2)` 直接挂余额。
- 新：`Member.balance`（`Decimal(14,2)`），**仅作冗余缓存**；**正本在 `ledger_entries`**（finance 域），由 `MemberService` 通过「唯一写入口 + 原子 UPDATE 守卫」维护。
- 币种：★ **2026-10-15 Q1 改判——账本面值 = CNY**（实测旧库对客全链路：`dg_order.goodsprice`／`dg_users.money`／`dg_record.money`／`dg_sendorder.totalfee` 同为人民币；配对 284,885 行扣款/货额比值 1.0331 = 5% 服务费口径）。原「日本市场主币 JPY 故余额以 JPY 计」的推断**不成立**：面向日本市场 ≠ 记账币种是日元，日元只出现在充值原币（`dg_rechargerecord.amount`）与月额（`monpayamt`）。故余额列仍配 `balanceCurrency`（默认 CNY）且**禁跨币种直接加减**。

> 与 `docs/07` 红线一致：金额服务端重算 + ledger + 四方对账。**精度用 (14,2)**（2026-10-15 Q8 定版；旧 `dg_users.money` 是 `decimal(10,2)`，实测最大余额 99,999,350.04 距上限仅 64.95 元 = 溢出风险，故整数位扩到 14）。

### 3.2 密码：MD5 → 需重新哈希（过渡期双读）

- 旧：`password CHAR(32)`（**MD5 无盐**）。
- 新：`passwordHash`（argon2id / bcrypt）。**过渡期策略**：登录时若命中旧 MD5 格式 → 校验通过后**透明升级**为 argon2 并回写。
- ➡️ 这是「共库并行」的硬约束：不打乱旧系统登录。

### 3.3 用户名唯一性：旧表漏了

- 旧：`uname` 只有普通 KEY，**允许重复**。
- 新：`username @unique`。
- ⚠️ **迁移风险**：加唯一约束前必须先跑重名核查 SQL；有重名需业务消歧。

### 3.4 时间戳：INT unix → DateTime

- 旧字段 `regtime`/`logintime`/`lastordertime`/`stoptime`/`validity` 是 INT unix 秒。
- 新：统一 `DateTime`。过渡期映射需 `FROM_UNIXTIME()` 视图或应用层转换。
- 精度：旧只到秒。新用 `DateTime(0)` 对齐，避免假精度。

### 3.5 多态外键：契约层必须收口

- `Favorite.favoriteable_type/id`、`PersonalAccessToken.tokenable_type/id` 是 Laravel morph。
- 决策：**DB 层保留（兼容旧数据）**，但 **`packages/contract` 不得暴露 `*_type` 原始字符串**；对外暴露成 `targetKind: 'product' | 'shop'` 枚举。这样既共库、又不让多态泄漏进契约。

### 3.6 软删除：分两种语义

- 可恢复（`v2_ecommerce_shop` 式）：`deletedAt` + `restoredAt`。
- 普通软删：仅 `deletedAt`。
- member 域目前：`OauthLogin`/`OauthTaobaoGlobal`/`Favorite*` 有或无 deleted_at——**统一为 `deletedAt DateTime?`**，恢复语义的实体再加 `restoredAt`。

### 3.7 索引：照搬旧表「真正被用到的」

旧表有些索引是重复的（如 `v2_supplier_product` 的 `idx_plat_gid` 与 `idx_platform_goods_id`）。新 schema 只保留：
- `Member`: `username`(unique)、`email`、`memberId`、`bizCode`、`state`
- `MemberAddress`: `uid`、`(uid, type)`
- `MemberWebhookDelivery`: `eventKey`(unique)、`(uid, createdAt)`、`(status, nextAttemptAt)`
- `OpenApiIdempotency`: `(uid, scope, clientKey)`(unique)、`createdAt`
- `BrowseHistory`: `uid`、`(uid, createdAt)`
- `Favorite`: `(uid, categoryId)`、`(favoriteableId, favoriteableType)`

### 3.8 禁外键 → `relationMode = "prisma"`

`docs/02`/`docs/07` 定死「禁外键与级联，引用完整性归应用层」。Prisma 里对应 `datasource.relationMode = "prisma"`（**模拟关系，不在 DB 建 FK**）。这样既可用 `include`，又不违反红线。

---

## 四、过渡期共存策略（Q7 已定：新表方案）

**决策**：**新表是唯一正本**，不继承旧表结构。旧表在过渡期保持「老系统可用、可回退」，由**同库、同事务双写**维持一致。

### 4.1 为什么不是「@@map 直连旧表」

用户要重构掉旧结构——MD5 无盐密码、`money` 挂用户、`float` 存金额、INT unix 时间戳、多态外键、各域 `status` 混用。`@@map` 直连等于把这些债原样背过来，重写失去意义。

### 4.2 为什么不做「新表 + 停机切换」（Big Bang）

违反迁移铁律 1（禁 Big Bang）与 3（数据共库）。旧系统必须随时可回退。

### 4.3 采用方案：新表正本 + 同库事务双写（过渡期）

关键：**双写发生在同一个 MySQL 的同一个事务里**——原子、无分布式提交问题、天然无漂移。铁律 3「禁双写不同库」针对的是跨库（无法原子），**同库双表**不在此列。

- 新系统**读**：只读 `member`（正本）。
- 新系统**写**：一个 `$transaction` 内 `upsert member_* + upsert dg_users/dg_address/v2_*`。
- 旧系统：**代码零改动、库照常读写**（`dg_users` 仍是它眼中的真实表）。

> 完整切换时序（T0 建表 → T1 回填 → T2 切写入口 → T3 旧表降级为只读投影）见
> `docs/plans/member-迁移与共存.md`。

### 4.4 双写的收口与坑

- **唯一写入口**：双写只允许出现在 `packages/db` 的 repository 层，禁散落到 service/route。
- **INT 时间戳**：写回 `dg_users.regtime` 等需转 unix 秒 → 统一在 repository 转换。
- **金额精度**：`member.balance` DECIMAL(12,2) ↔ `dg_users.money` DECIMAL(10,2)，写回按 2 位对齐。
- **密码**：`member.password_hash` 与 `dg_users.password`（CHAR(32) MD5）双写；登录升级时两侧同写新哈希（旧表若容不下 argon2 长度则写占位并标记，见迁移文档）。
- **主键对齐**：`member.id == dg_users.uid`（回填时显式带 id，再把 AUTO_INCREMENT 顶上去），保证跨域 JOIN 与旧系统一致。

### 4.5 反向同步（T1→T2 期间）

旧系统在 T2 之前仍可能写 `dg_users`（老登录/注册）。新系统对该窗口用**水位增量**（按 `updated_at`/`last_balance_changed_at`）把旧表变更合并回 `member_*`，直到 T2 关闭旧写入口后下线。

---

## 五、与 contract 的边界

- `packages/contract/src/domains/member.ts` 是**唯一**对外类型源。
- Prisma 生成的类型**禁止**出现在路由出参（`docs/07` c2：契约里不出现 ORM 类型）。
- 枚举词表（`state`/`bizCode`/`webhook status`/`benefit type`）在 contract 里定义为 zod enum + 常量，Prisma 侧仅用 `Int`/`String` + `///` 注释。

---

## 六、未决问题（需业务/用户确认）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | `dg_users.utype` / `usetype` / `state` 的完整枚举值？dump 无注释 | Member 状态字段契约 |
| Q2 | `finance_order_cash_flow.change_type` 的枚举值？需从旧代码反查 | finance 域（下一步） |
| ~~Q3~~ | ~~余额币种与精度~~ → **已定，但 2026-10-15 改判：CNY + `Decimal(14,2)`**（原判「JPY + 12,2」被实测推翻，见 `finance-schema.md` §3.3 与 §八 Q1/Q8）；跨币种靠 `balanceCurrency` 隔离，**禁跨币种直接加减** | ✅ 已决（改判） |
| ~~Q4~~ | ~~用户名唯一约束~~ → **已定：上 UNIQUE**；**查重已跑**（旧库只读）：22,611 用户中 **8 组 / 16 账号**重名（`utf8_general_ci` 语义），明细与消歧建议见 `docs/plans/02-用户名重名处置.md`；T1 回填前需业务定名（4 组待确认） | ✅ 已决（查重完成） |
| Q5 | `email_subscribe_status` 位运算的位定义？ | 通知订阅 |
| Q6 | `v2_user_platform_account` / `v2_platform_sub_account` 归 member 还是 order？ | 域边界 |
| ~~Q7~~ | ~~共存方案 A/B/C~~ → **已定：新表正本 + 同库事务双写**（§四） | ✅ 已决 |

---

## 七、下一步

1. ~~拍板 Q3/Q4~~ ✅ 已定（**Q3 已于 2026-10-15 改判为 CNY + Decimal(14,2)**；username UNIQUE）
2. ~~Q4 查重~~ ✅ **已跑**：8 组 / 16 账号（`docs/plans/02-用户名重名处置.md`）；**待业务确认 4 组** + 定 `member.username` collation（建议 ci）+ 补 `username_original`/`username_auto_renamed` 两列
3. `packages/db/prisma/schema.prisma` member 段已按**新表方案**产出（17 模型）；T0 建表 DDL 已生成于 `packages/db/sql/0001-member-domain-up.sql`
4. 待办：T0 建表 → T1 回填脚本（内嵌消歧映射）+ 双写 repository + 一致性校验（见 member-迁移与共存.md §八）
5. 写 member 域 contract（`packages/contract/src/domains/member.ts` 扩展）
6. 精读 order 域 → `docs/plans/order-schema.md`
