# 05 · OrderGroup 显式化评审与拍板（Q5 结果）

> 元信息：2026-10-14 · order 域 · TODO #10  
> 上游：`order-schema.md` §3.5 / §4.1 / §八 Q5  
> 实测数据源：本机 FlyEnv MySQL 9.7.2，库 `taotaro`（生产库本地副本，`dg_order` 328,479 行 / AUTO_INCREMENT 5,371,631）  
> 状态：**已拍板（2026-10-14）** —— 采纳方案 A（显式 `order_groups` 表）

---

## 一、执行与结论

| 项       | 值                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 问题     | 旧系统 tid 分组**隐式无表**，「整单砍价总额」靠 holder/carrier 机制挂在组内某一个 oid 上；新系统是否显式建模 `OrderGroup`？                                                                                         |
| **拍板** | **采纳方案 A**：新建 `order_groups` 表（`tid` UNIQUE 可空），`bargainAmount` 挂**组级**；`orders.groupId → order_groups.id`                                                                                         |
| 连带处置 | ① `carrier/holder/migrateAmountCarrierToSelf` 整套机制**删除**；② `orders` 不再保留行级 `bargainprice`（砍后单价 `bargainedUnitPrice` 保留为行级派生展示值）；③ 186 个多行持值异常组按 SUM 汇总天然处理，**不订正** |
| 影响面   | 回填策略（按 tid 建组）、send-order 域（`dg_sendorder.oids` 字符串拆分改 `groupId` 关联）、WMS（`dg_stores.oids` 同理）                                                                                             |
| 下一步   | 落入 `packages/db/prisma/schema.prisma` order 段 + `0002-order-domain-up.sql` + `0006-order-backfill-t1.sql`                                                                                                        |

---

## 二、问题重述：holder/carrier 机制是什么坑

业务现实：会员在 1688 一个店铺一次下单买 N 个商品 → **一个 tid → N 条 `dg_order`**（oids 逗号分隔出现在 `dg_sendorder.oids` / `dg_stores.oids` / `dg_fapiao` 多处）。

但「整单砍价总额」只有一列 `dg_order.bargainprice`（float NOT NULL，语义=**总额不是单价**）。旧系统的 hack：

1. 整单砍价挂在**同组某一个 oid** 上（holder），其余行置 0；
2. holder 选取规则：现规则 = **同组最大 oid**（2026-03 前是**最小 oid**，随 totalfee 统一改造变更）；
3. 后台编辑哪条订单的 sendprice/bargainprice，哪条就成为新 carrier（`migrateAmountCarrierToSelf()`）——**管理员动作改变数据归属行**；
4. `OrderAmountSyncService` 改价后按 tid 重算：`bargainprice = Σ max(0,(goodsprice−goodsprice1)×goodsnum)` 挂 holder，再按金额占比把 `goodsprice1` 分摊回各行。

后果：分组信息只存在于「同 tid」这个隐式约定里；`bargainprice` 的语义取决于**行在组内的位置**；砍价风控（Σ bargainprice > 30% 商品总额）必须先按 tid 分组汇总。

---

## 三、选项对比

|                                | A：显式 `OrderGroup`（拍板）                                        | B：维持隐式（新表照抄 holder 列）                | C：组表但砍价仍挂行                                          |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| 结构                           | `order_groups`（tid UK、bargainAmount、memberId）+ `orders.groupId` | `orders.bargainprice` + `orders.tid`，无组表     | `order_groups`（仅分组元数据）+ 行级 bargainprice + holderId |
| holder 机制                    | **整套删除**                                                        | 照抄（含 migrate 逻辑）                          | 保留 holderId 指向                                           |
| 砍价重算                       | 改组一行                                                            | 定位 holder 行（含历史两种口径判断）             | 同 B                                                         |
| `sendorder.oids`/`stores.oids` | 改 `groupId` 关联，字符串拆分消亡                                   | 逗号拆分照抄                                     | 同 A                                                         |
| 风控/对账                      | 组级一行直读                                                        | 每次 GROUP BY tid                                | 组级 + 行级两本账                                            |
| 回填复杂度                     | 按 tid 建组 + SUM 汇总（**口径无关**）                              | 需识别 holder 行（**口径相关**，238 个例外要判） | 同 B                                                         |
| 主要风险                       | 无——纯增量结构                                                      | 把已知硬伤继承进新系统                           | 两本账不一致风险                                             |

---

## 四、实测数据（本地 taotaro 副本，2026-10-14）

### 4.1 分组规模

| 指标                                 | 值                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `dg_order` 总行数                    | **328,479**（AUTO_INCREMENT 5,371,631，**oid 有大量空洞**，顶自增须用 MAX(id)+1） |
| 空 tid 行（`tid IS NULL OR tid=''`） | 11,988（3.6%）                                                                    |
| 非空 tid 分组数                      | **121,937**                                                                       |
| 组内行数分布                         | 单行组约 66,451；多行组最大 **72 行**                                             |
| `bargainprice<>0` 的行               | 55,890                                                                            |

### 4.2 holder 假设验证（§4.1 回填规则的关键依据）

| 组内非零行数         | 组数       |
| -------------------- | ---------- |
| 0（整组无砍价）      | 66,264     |
| **1（标准 holder）** | **55,486** |
| 2（异常）            | 185        |
| 3（异常）            | 1          |

持值行位置（55,859 个持值行）：

| 位置                       | 行数                                     | 占比       |
| -------------------------- | ---------------------------------------- | ---------- |
| 组内**最大 oid**（现规则） | 55,621                                   | **99.58%** |
| 非最大 oid                 | 238                                      | 0.42%      |
| 组内最小 oid               | 31,438（多为单行组 min=max，非口径证据） | —          |

### 4.3 空 tid 订单画像（§4.1「独立成组」分支的代价）

| 指标                        | 值                        |
| --------------------------- | ------------------------- |
| 空 tid 总数                 | 11,988                    |
| 其中有 bargainprice         | **仅 31**                 |
| 其中已绑运单（sid≠'0'）     | 2,605                     |
| 无效态（state 10/11/6）占比 | **94%**（10 态 9,495 行） |

### 4.4 结论

1. **99.58% 数据符合「最大 oid = holder」现规则**——但方案 A 的回填**不依赖这个规则**：按 tid `SUM(bargainprice)` 汇总，持值行在哪一行都一样，**两种历史口径天然兼容**；
2. 186 个多行持值异常组（185×2 行 + 1×3 行）SUM 汇总即为该组应付砍价总额，**无需订正脚本**——它们本就是「组级总额」的正确表达（Q11 由此收口：不做历史订正，见 §七）；
3. 空 tid 独立成组的代价：+11,988 个组，其中仅 31 个带砍价，且 94% 是无效态——**代价可忽略**；
4. `dg_order.sid` 存运单号（'0' = 未绑），回填 `orders.sendOrderId` 直接取该列；`dg_sendorder.oids` 逗号串仅作 T1→T2 反向同步校验用，**不作回填源**。

---

## 五、拍板结论与理由

**采纳方案 A**。核心理由（按权重排序）：

1. **语义正确性**：「整单砍价总额」本质是**组级**事实，挂在行上是旧系统无组表的妥协；新系统显式建模后，`bargainprice` 的行级歧义（在哪行、谁是 holder、迁移历史）**从数据模型里消失**；
2. **回填更简单而不是更复杂**：SUM 汇总口径无关，反而比「识别 holder 行」少 238 个例外判断；oid 空洞（MAX 5,371,631 / 实 328,479）提醒已存在于 member 回填铁律；
3. **删除机制而非新增机制**：carrier/holder/migrate + `dg_sendorder.oids` / `dg_stores.oids` 字符串拆分，三处硬伤一次清掉；
4. **下游域受益**：send-order 的 bargainstate/返金、WMS 的仓储关联、finance 的对账锚点，全部从「按 tid 分组聚合」降为「组级一行直读」。

**配套规则**（随拍板生效）：

- `order_groups.tid` UNIQUE **可空**（NULL = 未关联平台的手动建单/空 tid 历史单，每单独立成组）；
- `orders` 行级只保留 `bargainedUnitPrice`（砍后单价，`goodsprice1` 迁移），作为 `OrderGroup.bargainAmount` 分摊后的**派生展示值**——回填时原样搬运，不做重新分摊；
- `OrderGroup.bargainAmount` 回填口径：**同 tid 全部行 `SUM(bargainprice)`**（float 两位小数 → Decimal 无损）；
- 组级还汇总 `shippingFeeTotal`（旧 sendprice 按 tid SUM）——send-order 域「已邮寄返金」的 Σ sendprice 口径有组级快照可依。

---

## 六、对下游的影响（已确认）

| 下游          | 影响                                                                                                                    | 处置                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| T1 回填       | `order_groups` 按 tid 建组（空 tid 每单一组）；`orders.groupId` 回填；holder 行的 bargainprice **归组**，行级不再有该列 | `0006-order-backfill-t1.sql` |
| send-order 域 | `dg_sendorder.oids` 逗号串不再作为关系正本；运单侧经 `orders.sendOrderId`/`groupId` 反查                                | `send-order-schema.md` 落实  |
| WMS 域        | `dg_stores.oids`/`outoids` 同理由关系表替代（WMS 独立项目时定）                                                         | 预留                         |
| finance 域    | 砍价返金（action=11）以 `OrderGroup.bargainAmount` 为口径源，禁再用 `dg_sendorder.bargainprice` 互推                    | 对账设计时落实               |
| 砍价风控      | 30% 预警从「按 tid 分组汇总」变组级一行                                                                                 | admin 实现时落实             |

---

## 七、遗留事项

| #   | 事项                                                                  | 处置                                                                                            |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | 186 个多行持值异常组的成因（疑似历史最小 oid 口径残留或改单迁移痕迹） | **不订正**。SUM 汇总即为组级正确值；如业务需要审计，按 `order_groups` 建组后反查 `tid` 即可定位 |
| 2   | 空 tid 但 bargainprice≠0 的 31 行                                     | 独立成组时砍价额随行入组，无丢失                                                                |
| 3   | `orders.groupId` 可空性                                               | 允许 NULL（极端情况：回填后组表被清）；查询侧禁「组必存」假设                                   |
| 4   | 2026-03 口径切换对 `goodsprice1` 分摊尾差的影响                       | 只搬历史值不重算，尾差（1~2 分）原样保留                                                        |

---

## 八、复现方式

```sql
-- 本机 FlyEnv MySQL 9.7.2，库 taotaro（生产本地副本）
SELECT COUNT(*), SUM(tid IS NULL OR tid=''), COUNT(DISTINCT tid), SUM(bargainprice<>0) FROM dg_order;
SELECT cnt_nonzero, COUNT(*) FROM (
  SELECT tid, SUM(bargainprice<>0) AS cnt_nonzero FROM dg_order
  WHERE tid IS NOT NULL AND tid<>'' GROUP BY tid
) t GROUP BY cnt_nonzero;
SELECT SUM(o.oid = m.max_oid), SUM(NOT (o.oid = m.max_oid)) FROM dg_order o
  JOIN (SELECT tid, MAX(oid) max_oid FROM dg_order WHERE tid IS NOT NULL AND tid<>'' GROUP BY tid) m
  ON o.tid = m.tid WHERE o.bargainprice <> 0;
```

> 生产库全量口径需在 T1 前用跳板机只读通道复核一次（本地副本为子集，组形态分布可能与全量有差异；但 SUM 汇总回填**不依赖分布**，仅影响组表规模预估）。
