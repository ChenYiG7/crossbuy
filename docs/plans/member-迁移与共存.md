# member 域迁移与共存（新表方案）

> 决策来源：用户 2026-10-13「表我也想重构掉」→ Q7 定：**新表为唯一正本**。
> 配套：`docs/plans/member-schema.md`（设计）、`packages/db/prisma/schema.prisma`（正本）。
> 纪律依据：`docs/07-开发规范守则.md`、迁移铁律（AGENTS.md）。

---

## 一、决策与三条前提

**决策**：member 域用**全新、干净的表**（`member` / `member_address` / …），不继承 `dg_users` 等旧结构。

**三条前提（缺一不可）**：

1. **旧系统零改动**：haiou 生产运行中，不改它的代码、不改它的表结构。它继续把 `dg_users` 当真实表读写。
2. **同库**：新旧共用一个 MySQL（铁律 3）。旧表 + 新表**并存于同一库**。
3. **可回退**：任一时刻关掉新系统 member 写入口，旧表数据仍完整、旧系统照常。

> 为什么「同库双写」不违反「禁双写不同库」：该铁律针对**跨库**（无法原子、必然漂移）。同库同事务双表写是**原子**的，无此问题。

---

## 二、切换时序（四段）

```
T0 建表 ──► T1 回填 + 读新写双 ──► T2 切写入口 ──► T3 旧表降级只读投影
   (additive)   (新系统读 member，写 member+dg_users)  (旧写入口归零)   (供未切换域 JOIN)
```

### T0 建新表（additive，旧表不动）

- 按 `schema.prisma` 建 `member_*` 全套新表。
- 新表 AUTO_INCREMENT 起始值先留空，等 T1 回填后再顶高。

### T1 回填 + 读新写双

- **回填**：`dg_users` → `member`（**显式带 id**，保证 `member.id == dg_users.uid`），分批 + 幂等 upsert。
- 同理回填 `dg_address`→`member_address`、`v2_member_webhook*`、`v2_oauth_*`、`v2_open_api_idempotency`、`v2_favorite*`、`v2_user_browse_history`、`user_benefit*`、`user_operation_log`、`v2_area`→`area`。
- ★ **带 member 必需关系的一律 `JOIN member` 过滤孤儿**（`member_address` 于 2026-10-15 补上，此前会落悬空 `member_id`）。旧库允许子记录挂已删会员，新表若继承悬空，Prisma 必需关系 `include` 直接报错。代价：这些行不进新表 → 校验脚本用 INFO 项报告数量（`0003` B13），T3 旧表降级前按源 id 补录。
- ★ **重名消歧映射 = 实体暂存表 `_t1_username_fix` / `_t1_username_merge`**（`0002` §1 DROP+CREATE，正本在脚本字面量里、随 git 走；留库作审计）。回填前有 fail-fast 守卫 `_guard_username_disambiguated`：**映射没覆盖到的重名组一律中止**，绝不让 `INSERT..ODKU` 把后一个账号整行盖到前一个账号身上（`member.username` 是 UNIQUE，撞键 = 两个不同实体）。细则见 `docs/plans/03` §9.2/§9.7、TODO **#3g**。
- **回填后**：`ALTER TABLE member AUTO_INCREMENT = <max(uid)+1>`，避免新记录撞旧 id。
- **读**：新系统只读 `member_*`。
- **写**：新系统每个写操作在**同一个 `$transaction`** 内 `upsert member_*` + `upsert 旧表`。
- 旧系统此阶段仍全量读写旧表（含登录/注册/资料）→ 需要**反向同步**（见 §四）。

### T2 切写入口

逐个把旧系统里「会写 member 数据」的入口迁到新系统（登录、注册、改资料、改地址、充值入口的会员侧、webhook 配置…）。**每迁一个，该入口在旧系统变为只读**。

- 出口条件：旧系统对 `dg_users` 的写入口归零（用审计/慢日志确认）。
- 此时反向同步可下线；双写开始向「只写 member + 单向投影」演进。

### T3 旧表降级为只读投影

- `dg_users` 等旧表改为**从 `member_*` 单向同步**（触发器或定时 Job），供**尚未切换的域**（order/finance…）继续 JOIN。
- 随各域逐步切换，旧投影表逐个退休。

---

## 三、字段映射表（双写时的转换规则）

> 双写只在 repository 层实现（唯一写入口）。下列差异必须在此层统一处理，禁散落。
>
> ⚠️ **2026-10-13 修订**：`dg_users` 实际为 **75 列**（此前依据的 `taotaro.sql` dump 是旧版，只有约 55 列）。已按线上 `information_schema` 全量核对；`biz_code` / `belong_company` / `tag` / `shopname` / `shopurl` / `prebuyfeq` / `prebuyamt` / `enname` / `monpayamt` / `origin_package_choice` / `stores_*` / `cc_emails` / `email_subscribe_status` **均确实存在**（`shopname`→`shop_name` 等为命名差异）。回填实现见 `packages/db/sql/0002-member-backfill-t1.sql`。

| `member` 列（新）    | `dg_users` 列（旧） | 转换 / 坑                                                                                                                                                                                                      |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `uid`               | 恒等，主键对齐                                                                                                                                                                                                 |
| `username`           | `uname`             | 旧仅普通索引（可重名）→ 新加 UNIQUE，**上线前须查重**（Q4 ✅ 已完成：8 组/16 账号）。**新列排序规则必须显式定为 `utf8mb4_general_ci`**（否则表级默认 `unicode_ci` 会把重名扩到 24 组，见 `docs/plans/03` §五） |
| `password_hash`      | `password`          | 旧 CHAR(32)=MD5 无盐。**过渡期双写**：新存 argon2 时，旧列写不下 → 旧列写 `!upgraded!`+短标记占位，并置 `password_algo` 标记；登录时若旧列仍是 MD5 可回退校验                                                  |
| `email`              | `email`             | 旧 CHAR(50)，无唯一                                                                                                                                                                                            |
| `balance`            | `money`             | `Decimal(14,2)` ← 旧 `decimal(10,2)`，**原值直迁不做换算**；★ 旧库面值本身就是 CNY（2026-10-15 Q1 改判），故 `balance_currency` 默认 **CNY**                                                                   |
| `float_rate`         | `floatrate`         | 一致                                                                                                                                                                                                           |
| `scores`             | `scores`            | 一致                                                                                                                                                                                                           |
| `created_at`         | `regtime`           | **DateTime ↔ INT unix 秒**：写旧表要 `Math.floor(t/1000)`                                                                                                                                                      |
| `last_login_at`      | `logintime`         | 同上                                                                                                                                                                                                           |
| `last_order_at`      | `lastordertime`     | 同上                                                                                                                                                                                                           |
| `stop_time`          | `stoptime`          | 同上                                                                                                                                                                                                           |
| `validity`           | `validity`          | 旧 INT（语义待确认，可能也是时间戳）                                                                                                                                                                           |
| `df_flag` / `df_fee` | `dfflag` / `dffee`  | 一致                                                                                                                                                                                                           |
| `biz_code`           | `biz_code`          | 一致（MZK / PROXY_PURCHASE）；✔ 实测该列**确实存在**（曾存疑）                                                                                                                                                 |
| `mon_pay_amt`        | `monpayamt`         | ⚠ 旧为 **DOUBLE 浮点** → 回填先 `ROUND(...,2)` 再落 `DECIMAL(12,2)`（又一个「float 存金额」实例）                                                                                                              |
| `password_algo`      | ——                  | **新列**：回填旧数据置 `md5`，升级后置 `argon2id`；用于双读判据                                                                                                                                                |
| `balance_currency`   | ——                  | **新列，旧表无**（双写时忽略）                                                                                                                                                                                 |
| `remember_token`     | `remember_token`    | **不迁移**：旧系统会话自用；新系统用 Auth.js 会话                                                                                                                                                              |
| 法人信息             | `com*` 组           | 拆到 `member_company`（1:1）。⚠ **修正**：不能只按 `regType=1` —— 实测 `regtype=1` 仅 **2,246** 人，而 `comname` 非空者 **7,409** 人。回填条件改为「`regType=1` **或任一 com\* 字段非空**」                    |
| `legacy_api_token`   | `apitoken`          | **不迁移**：由 `personal_access_token` 取代；旧 token 在 T2 一次性重签                                                                                                                                         |

**多态外键**（`favorite.favoriteable_type/id`、`personal_access_token.tokenable_type/id`）：DB 层照原样写（旧数据能读），**契约层收口为枚举**。

---

## 四、反向同步（T1→T2 窗口）

T2 之前旧系统仍在写 `dg_users`（老登录/注册/后台改资料）。新系统必须在同一窗口内看到这些变更。

- **机制**：水位增量拉取——按 `dg_users.last_balance_changed_at` + `user_operation_log`（资料修改审计）从旧表拉变更，合并进 `member_*`。
- **顺序**：以时间戳为序，**新系统自身写入 wins**（避免自己的双写在反向同步里被回滚）。
- **下线**：T2 出口条件达成（旧写入口归零）后，反向同步 Job 停用。

> 若 T1 窗口内跑不起来反向同步，降级方案：T1 期间新系统对 member **只读**（不写），双写延到 T2 一次开启——牺牲一段「并行写」，换简单。

---

## 五、回退方案

| 触发                     | 动作                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| 新系统 member 出严重 bug | 关掉新系统 member 写入口与路由，流量回旧系统；旧表因一直同事务同步，数据完整 |
| 双写事务失败             | 事务整体回滚（原子），旧表不受影响                                           |
| 回填出错                 | `member_*` 清空重跑（回填幂等），旧表不动                                    |

---

## 六、验收（可执行出口）

1. **回填一致性**：`member` 与 `dg_users` 按 uid 全字段比对，差异 = 0（除已知占位列）。
2. **双写一致性**：随机 100 次写操作后，两侧字段比对差异 = 0。
3. **幂等**：同一请求重复执行 N 次，`member*` 与旧表均无重复行。
4. **回退演练**：关写入口 → 旧系统跑通登录/下单 → 通过。
5. **反向同步**：旧系统改一条资料，N 秒内 `member` 可见。

---

## 七、风险与对策

| 风险                  | 对策                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| 双写代码散落          | 强制收口在 `packages/db` repository；ESLint 禁止 service/route 直连旧表 |
| 字段语义漂移          | 映射表 + 单测钉住每个转换（尤其 INT 时间戳、金额精度）                  |
| 大表回填锁表          | 分批（按 uid 区间）+ 低峰执行 + 幂等 upsert                             |
| 忘记顶 AUTO_INCREMENT | 回填脚本内置校验（断言 AUTO_INCREMENT > max(id)）                       |
| T2 有漏网的旧写入口   | 用 MySQL 审计/慢查询日志核验 `dg_users` 无写                            |
| 忘记下线反向同步      | 作为 T2 出口检查项，写进切换 checklist                                  |

---

## 八、待办

- [x] 拍板 Q3（余额 JPY + `Decimal(12,2)`；**2026-10-15 改判为 CNY + `Decimal(14,2)`**，理由见 `finance-schema.md` §3.3/Q1）、Q4（用户名 UNIQUE，前置查重）
- [x] 写迁移 SQL：建 `member_*` 表（T0）→ `packages/db/sql/0001-member-domain-up.sql`（由 schema.prisma 生成，**16 表**；2026-10-15 finance 段落地后，原占位表 `ledger_entry` 已移出本段，见 `finance-schema.md` §5.1）
- [x] 写 Q4 前置核查 SQL → `packages/db/sql/precheck-username-duplicate.sql`
- [x] 执行 Q4 查重（旧库只读）→ 8 组 / 16 账号；业务已拍板消歧 → `docs/plans/02-用户名重名处置.md`
- [x] 补 `0001a-member-username-collation.sql`（username 定 `utf8mb4_general_ci`）
- [x] 写回填脚本（幂等 + 显式 id + 消歧映射 + fail-fast 守卫 + 顶 AUTO_INCREMENT）→ `packages/db/sql/0002-member-backfill-t1.sql`
- [x] 写一致性校验脚本 → `packages/db/sql/0003-member-backfill-verify.sql`（**21 项**，期望值按当前源实时计算；旧版 15 项里有 4 项把生产快照数字写死，见 `docs/plans/03` §9.4）
- [x] **本地演练 T0→T1→校验**：15/15 PASS、3 遍幂等、回退 OK → `docs/plans/03-T1本地演练报告.md`
- [x] ★ **#3g 硬化后的复跑**（2026-10-16，独立新库 `crossbuy_t1v` 从零跑）：空库全链 rc=0 → `0003` **17 PASS + 4 INFO + 0 FAIL**（B2/B12 证地址孤儿过滤生效：2,147 行 / 悬空 0 / 过滤 7,324）→ 两遍计数与 Σbalance 不变（5,021 / 115,263,684.24 / 2,147）→ **故意删映射行 + 用生产映射跑本地快照**两种破坏都被守卫 `rc=1` 拦停并点名 → `0014` 审计 15 表来源与行数全对。证据 `docs/plans/03` §十、判定口径 `packages/db/sql/README.md`
- [ ] **★ 生产写权限**：`datapro` 只读 → 需 DBA 用具备 DDL/DML 的账号执行 ①~③
- [ ] 第一回填批（侧表）：T1 期间双写 `MemberRepository`（双写事务 + 反向同步水位）
- [x] 第二批侧表回填（webhook/oauth/favorite/browse_history/benefit/operation_log/area/PAT/idempotency）→ `0004`/`0005`，本地 25 项 PASS（TODO #3e）
- [ ] 双写一致性验收（验收 2）+ T2 切换 checklist（含旧写入口核验、反向同步下线）
