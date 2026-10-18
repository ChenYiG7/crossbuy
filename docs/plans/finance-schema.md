# finance 域 schema 设计（精读旧系统后）

> 元信息：2026-10-15 建立 | 涉及域：finance（+ 跨域扣费事件的归账终点）| 对应 TODO：**#11**（finance + 对账体系）、**#3b**（`change_type` 枚举反查，本文收口）
> 上游依据：docs/02 §五（账本化 + 5 类对账）、docs/06 §五-3（阶段 2 第 3 刀）、docs/07 §3（账本型并发）、§6（schema 规约）
> 迁移铁律 4「金额不可信」的**落地域**：order 扣费事件、send-order 已邮寄返金、member 余额，终点都在这里。

## 取证通道与可信度（先声明，避免后人误读）

| 通道                                                      | 用途                                               | 局限                                                                                                                                                                        |
| --------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `haiou/taotaro.sql`（2026-10-13 从生产导出的 174 表结构） | **列级正本**：列名/类型/索引/AUTO_INCREMENT        | 无数据；枚举注释基本缺失                                                                                                                                                    |
| 本地副本库 `taotaro`（FlyEnv MySQL 9.7.2）                | **数据画像**：取值分布、不变式violations、配平实测 | `dg_record` 是 **rid 连续尾切片**（6,518,020–7,334,199，2025-03-08 起）；`dg_rechargerecord` **缺 `ext_info`/`gateway_transaction_no` 两列**（副本 schema 落后于生产 dump） |
| `haiou/backend` 代码（只读）                              | 枚举词表、写入点、锁与事务实况                     | Finance 域业务文档 **0 篇**（核实：`backend/docs/business/` 无 finance 文档），全靠逆向                                                                                     |

⚠️ 本文所有「实测」数字都来自本地尾切片，**规模级结论需在生产只读通道复核后才能用于回填策略**（同 order/send-order 域做法）。

---

## 一、域边界

### 1.1 finance 域负责

- **余额正本**：会员账户余额的唯一真相 = ledger 账本；`member.balance` 降级为**可重建的缓存投影**（member-schema.md §3.1 已定「money 不是正本」，本文负责把它做成正本）。
- **账本事件词表**：扣款、充值、返金、运费、改价改量、人工调整……每一个动钱动作都有类型、方向、币种、快照。
- **充值/退款单据**：支付渠道入账凭证、审核流、网关交易号幂等。
- **四方对账**：支付渠道 / 余额 / 供应商 / 物流（+ 汇率）五类比对，结果留痕。
- **费率与汇率**：服务费 5%、`dffee`、1.05 乘数、对客浮动汇率 `floatrate`——order/send-order 域的 Q7 都指向本域（费率配置化归 finance 哪个服务）。
- **告警**：对账不平、余额异常、砍价超阈 → 钉钉。

### 1.2 finance 域不负责（跨域，禁直接建库关联）

| 事项                                               | 归属                                     | 与本域的关系                                        |
| -------------------------------------------------- | ---------------------------------------- | --------------------------------------------------- |
| 订单金额构成、砍价分摊、`OrderGroup.bargainAmount` | order                                    | 扣费/返金事件的**发起方**，只向本域提交「账本命令」 |
| 运单五费 `totalfee`、已邮寄返金事务                | send-order                               | 同上（`action=3` 扣运费、`action=11` 返砍价）       |
| 会员身份、`balance_currency`、余额低阈值           | member                                   | 余额列的**宿主表**，本域写、member 域只读投影       |
| 货架/库存/仓储费计价规则                           | WMS（独立项目）                          | 本域只记仓储费流水，不算仓储费                      |
| 支付渠道 SDK 与回调验签                            | 防腐层（`adapter/<vendor>`，docs/07 §5） | 回调落本域充值单，验签在 adapter                    |

### 1.3 一笔钱的本域生命周期（总览）

```
充值：渠道回调 → recharge_orders（审核） → ledger(CR 充值)  ─┐
下单：order 域 payOrder()                    → ledger(DR 扣款)  ├─→ 余额投影 member.balance
改价：order 域 modifyGoodsprice()            → ledger(DR/CR 差额) │
邮寄：send-order 域 BatchUpdateDFSendorder() → ledger(DR 运费 + CR 返砍价) ─┘
对账：worker 定时 → reconciliation_batches / _diffs → 不平则钉钉 + 冻结标记
```

关键设计约束：**任何跨域动钱都必须经本域唯一写入口**（docs/07 §3.1），旧系统「order 模型里直接 `addMoney()` + 5% 硬编码」的形态必须终结。

---

## 二、实体清单与源表映射

> 记号：★=本域新建（旧系统无对应表）；直=直连旧表语义；弃=不迁

| #   | 新模型（拟）                                       | 旧源表                                                                                      | 处置                                                                                                                                                                                                                     |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `LedgerEntry`                                      | `dg_record`（807 万，**客户余额流水**）                                                     | ★ 重写：补方向/币种/业务唯一键/快照不变式                                                                                                                                                                                |
| 2   | `Account`                                          | `dg_users.money` + `dg_users.last_balance_changed_at`                                       | ★ 账户行（余额正本挂载点，唯一写入口的守卫对象）                                                                                                                                                                         |
| 3   | `RechargeOrder`                                    | `dg_rechargerecord`（59 万）                                                                | 直改：拆「入金渠道」与「费用原因」两列（现混在 `paytype` 一列）                                                                                                                                                          |
| 4   | `ExchangeRate`                                     | `dg_huilv`（汇率表，`huilv float(10,2)`，Job 每小时整点写）                                 | 直改：float → Decimal(12,8)（docs/07 §6.2 汇率精度）；**旧表无快照引用，须补 `ledger_entries.rate_id`**                                                                                                                  |
| 5   | `PurchaseCashFlow`                                 | `finance_order_cash_flow`（102 万，**采购侧资金流水**）                                     | ★ 折入 `LedgerEntry`（`flowType=PURCHASE_*`）+ 订单关联走列                                                                                                                                                              |
| 6   | （弃）`relation_order_and_finance_order_cash_flow` | 261 万行多对多                                                                              | ❌ 流水直接带 `orderId`（order-schema.md:83 已定）                                                                                                                                                                       |
| 7   | （弃）`dg_refund`                                  | 118 行，`money float(10,2)`                                                                 | ❌ **确证废弃**：`app/database/tests/vendor/frontend` 全 0 引用、无 Model 无 migration                                                                                                                                   |
| 8   | （弃）`relation_bill_and_model`                    | 185 行多态「金额明细表」                                                                    | ❌ **确证废弃**：全仓 0 引用，注释所指主表不存在                                                                                                                                                                         |
| 9   | （不建）`RecordOld`                                | `dg_record_old`（598 万行）                                                                 | ✔ **确证已停写、纯只读归档**（4 处引用无写入点，§3.9）：一次性回填不镜像；`rid` 与主表空间重叠 → 靠 `legacy_source` 区分（§4.12）。后台路由 `finance/user-bills-old` 仍在用 → 是否并入决定旧表要不要留只读投影（§八 Q2） |
| 10  | `ReconciliationBatch` / `ReconciliationDiff`       | **旧系统无表**                                                                              | ★ 对账批次 + 差异留痕（docs/02 §5.3 要求）                                                                                                                                                                               |
| 11  | `FeeRule`                                          | 代码常量（`AMTLIMITFEE=1.05`、5%、`dffee` 默认 10、PayPal `(x*0.964-40)`、Stripe `x*0.96`） | ★ 费率配置化（收 order 域 Q7）                                                                                                                                                                                           |
| 12  | `AlertEvent`                                       | 钉钉散点调用                                                                                | ★ 告警出口（幂等 + 频控）                                                                                                                                                                                                |
| 13  | （不建）`BargainRecord`                            | `dg_bargain_record`（8 万）                                                                 | ✔ 归 order 域：`UNIQUE(goodid,goodstype)` 是**砍后价价格字典**，不涉资金（`BatchUpdateOrder.php:735` 写、`Cart.php:202` 读）                                                                                             |
| 14  | （不建）`ScoreRecord`                              | `dg_scorerecord`（18 万）                                                                   | ✔ **与钱无关**（积分 `type` 1获得/2消费），唯一写入 `ConfirmReceiveSendOrderMutation.php:92`                                                                                                                             |
| 15  | （不建）`Coupon`                                   | `dg_coupon`（1,423）                                                                        | ✔ **事实废弃**：所有下单路径 `couponid/couponmoney` 硬编码 0（`CreateDfOrderMutation.php:485` 等 4 处），无创建/核销代码                                                                                                 |
| 16  | （观察）`dg_payid`                                 | 41 行 `payid/payabout/uids(逗号串)`                                                         | 收款账户配置，`uids` 逗号分隔违反 §6.2 → 建议归 member 或本域 `AccountGroup`（§八 Q5）                                                                                                                                   |
| 17  | （不迁）`v2_statistics`                            | 16,934 行 KV 统计快照                                                                       | 报表走新查询，对账另建表                                                                                                                                                                                                 |

---

## 三、旧系统 finance 域全景精读（建模前必读）

### 3.1 `dg_record`——客户余额流水（**旧 ledger**，807 万行）

> 词表（`action` 全量）、幂等实况、`accountmoney` 成因分析在 **§3.9**（本轮旧代码逆向的收口成果）。

列分组精读（`taotaro.sql:1873-1897`）：

| 组            | 列                                                                                                                                 | 实测（本地尾切片 502,163 行）                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主体          | `rid` PK / `uid` / `uname`                                                                                                         | uid 1,684 个（切片内）；`uname` 冗余（同 order 域 §4.10，禁迁）                                                                                          |
| **方向+原因** | `type` smallint 默认 1 / `action` smallint 默认 0                                                                                  | ★ **`type` 就是收支方向**：`type=1` 全为负（381,679 行 action=1，min -347,760，仅 4 行 0）、`type=2` 全为正；`type` 取值**只有 1 和 2**（实测 0 行越界） |
| 金额          | `money` **decimal(12,2)**                                                                                                          | 无 NULL；单行极值 **±10,000,000**（`action=0 type=2`）                                                                                                   |
| **余额快照**  | `accountmoney` decimal(12,2)                                                                                                       | 无 NULL——**每行都存动账后余额**（旧系统已有「running balance」意识）                                                                                     |
| 关联          | `oid` / `sn` varchar(500) / `ordflag`                                                                                              | `oid>0` 占 87%；`sn` **89% 为空**，74 行超 50 字符（拼接多个单号）；`ordflag` 3（代发）50,756 行                                                         |
| 元信息        | `remark` varchar(255) / `addtime` INT unix / `vip` / `extend` json / `deleted_at`                                                  | `vip` **全 0**（定额会员标记形同虚设）；`extend` 仅 349 行非空；软删 93 行                                                                               |
| 幂等          | `idempotency_key` varchar(128) **UNIQUE**                                                                                          | ★ **100% NULL**（502,163/502,163）——列加了但**从未启用**                                                                                                 |
| 索引          | PK / `uk_idempotency_key` / `idx_oid` / `idx_uid` / `idx_addtime` / `idx_uname` / **`idx_uid_action_addtime(uid,action,addtime)`** | 最后一个是真实查询口径：**按会员按事件类型按时间拉流水**                                                                                                 |

**`remark` 的两种形态**（决定新系统「说明文案」必须结构化）：

- `action=1/3/4/5/6/9/10/11`：**模板化**（`LEFT(remark,6)` 去重后仅 1–8 种，长度 39–388 字节）；且 `action=4` 的 remark 里**嵌 HTML 片段**（实测开头 `<a href='ht`、`<span lang="`）——富文本混进流水说明。
- `action=0`：**自由文本**（1,888 种前缀，长度 1–627 字节），例：`YBQ14217阿部輝様`、`1`。→ **`action=0` 是「杂项/人工调整」黑洞**，最大金额也在这里（`type=2` 均值 +17,737，`type=1` 均值 -4,589）。

### 3.2 `dg_rechargerecord`——入金/调整单据（59 万行）

`taotaro.sql:1838-1871`。实测（本地 34,918 行，rid 481,984–534,768）+ 代码确证：

| 列                                           | 注释                                         | 确证结论                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amount` decimal(10,2)                       | 充值原始额度                                 | = **JPY 原币额**（后台 Grid 明示 `RechargeRecordController.php:113-114`）                                                                                                                                                                                                                                                                             |
| `money` decimal(10,2)                        | 换算过的额度                                 | = **CNY 入账额**，`money = round(amount / huilv, 2)`（`Repositories/Finance/RechargeRecord.php:531-533`、`BankTransferMutation.php:107-129`）                                                                                                                                                                                                         |
| `currency` varchar(10)                       | 币种                                         | ★ 几乎不写：只有 PayPal 建单写**小写 `'jpy'`**（`GetPaypalTransferConfigQuery.php:93`），其余 NULL，且 `MYR` 出现大写 → 币种列不可信、大小写不统一                                                                                                                                                                                                    |
| `paytype` smallint                           | DDL 注释「0转账 1支付宝 2paypal 3psi 4其他」 | ★ **注释已过期**，词表正本在代码 `RechargeRecord.php:60-91`：0 銀行振込 / 2 Paypal / 3 商品購入 / 4 国際運賃 / 5 国内運賃 / 6 賠償 / 7 家賃 / 8 オプション / 9 送金 / 10 取引中止 / 11 その他 / 12 撮影 / 13 保険料 / 14 订单增值 / 15 Stripe。**`alipay`/`psi` 全仓 0 命中**（1、3 语义被覆盖）。实测 0–14 均有数据，15 无（Stripe 集成仍 drafting） |
| `state` smallint 默认 1                      | DDL 无注释                                   | ★ 词表正本 `RechargeRecord.php:118-129`：**-1 已驳回 / 1 待审核(待支付) / 2 已完成 / 3 待核对流水**。实测四值齐全                                                                                                                                                                                                                                     |
| `successtime` INT                            | 成功时间                                     | ★ **加钱那一刻写入**，但「已完成 state=2」和「待核对 state=3」都已有值 → **不能用作「已到账」判据**                                                                                                                                                                                                                                                   |
| `audit_admin_uid`                            | 审核人                                       | ★ **银行初审路径全程不写此列**（只有手动扣款审核 `ReviewManualCharge.php:34-50` 写）→ 审计断链                                                                                                                                                                                                                                                        |
| `gateway_transaction_no` varchar(128) UNIQUE | 网关交易号                                   | 列在生产库存在（`taotaro.sql:1861`），**backend 代码 0 引用** → 由外部 Python 服务写；本地副本无此列                                                                                                                                                                                                                                                  |
| `source` varchar(32)                         | hho/gouba                                    | `hho` / `gouba` / NULL=yiwutaro（`RechargeRecord.php:52-54` + `User.php:613`，migration 2026-05-09）；本地副本无此列                                                                                                                                                                                                                                  |

**加钱时刻与审核流**（确证，直接决定 ledger 的「事件产生点」）：

| 场景                          | 流转                                                                                                                                                                                                                                                                   | 动账点     | 幂等                                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 银行转账                      | 用户提交 state=1（`BankTransferMutation.php:133`）→ 财务初审 radio「3=审核通过 / -1=驳回」（`RechargeRecordReviewForm.php:31`）→ **1→3 即加钱**（`Repositories/.../RechargeRecord.php:88-103`）→ 3→2「完成核对」**不再加钱**（`RechargeRecordReviewAction.php:83-97`） | state→3    | 仅 `Cache::lock(...,10s)`（`RechargeRecordController.php:506`）                                                                                                              |
| 手动扣款（paytype 14/5/11/6） | 业务员 `ManualCharge.php:41-58`（amount=0、money 可负、state=1、写 submit_admin_uid）→ 审核 **1→2 并加钱**                                                                                                                                                             | state→2    | 同上                                                                                                                                                                         |
| 后台直接新建                  | state/successtime 直接置 2，事务内 addMoney（`Controller:490-492` + `Repositories:42-67`）                                                                                                                                                                             | 创建即加钱 | 无                                                                                                                                                                           |
| PayPal 回调                   | IPN `/api/webhooks/paypal_notify` → 1→2 + 加钱（`PaypalController.php:111-134`）                                                                                                                                                                                       | state→2    | ★ **`Cache::lock('paypal-webhook-{sn}-{status}', 2)` + 「state==2 则 return」= 先查后改、无事务、无唯一键 → 锁 2 秒过期即可重复加钱**（`PaypalController.php:49-52,97-106`） |
| Stripe                        | 外部服务写 `gateway_transaction_no` UNIQUE + `FOR UPDATE` 设计（`docs/business/stripe-recharge-integration.md:405`，状态 **drafting**，PHP 侧未找到写入点）                                                                                                            | —          | 唯一键（正解）                                                                                                                                                               |

**`paytype` 混装两个维度**（入金渠道 vs 费用原因）是旧模型最深的结构问题：`3 商品購入 / 4 国際運賃 / 5 国内運賃 / 7 家賃 / 12 撮影 / 13 保険料` 是**费用项**，`0 銀行振込 / 2 Paypal / 15 Stripe` 是**渠道**；`inboundPayTypes()` 白名单（`RechargeRecord.php:98-106`）就是为了让代码能分辨——实测 `paytype` 11/12/13/14/3/4/5/7/8/9/10 的 `money` 合计为**负数**（11 段 -4,427,426.16）。**★ 2026-10-16 精确实数**：`state=2` 且 `money<0` 共 **11,182 行**（remark 形如「YBQ14217阿部輝様‐OEM、検品代50元、担当：何」——是费用代扣，不是入金），且这 11,182 行**全部**能在 `dg_record` 按 `sn` 找到对应行（JOIN 后 11,186 行，多出的 4 行是 `sn` 重复）⇒ **钱只记在 `dg_record` 一处**，`dg_rechargerecord` 是单据。所以 T1 里 `recharge_orders` 只装正向单、分录一律来自 `dg_record`，两头都建分录必然双计。→ 新系统必须拆成 `channel` + `reason` 两列，且把「负向调整」从充值表里搬走，否则**支付渠道对账的分母里混着人工调整，永远对不平**。

**后台「改写金额」后门清单**（对账差异来源，§五 `ReconciliationDiff` 的 reason 词表）：

| #   | 后门                                                                                                            | 位置                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| a   | 改汇率**反算** `money`（Grid 汇率单元格本身可编辑），且**已加钱的 state=3 行也能改** → 历史流水与单据永久不一致 | `RechargeRecordController.php:121-132, 531-533`                           |
| b   | 表单直接暴露 `money` 与编辑态 `state` 下拉，手改**不补写流水**                                                  | `Controller:326,348`                                                      |
| c   | 批量「完成核对」**裸 UPDATE 跳过守卫**                                                                          | `RechargeRecordBatchUpdate.php:62`                                        |
| d   | `remark` 自由改写——而 remark 里含汇率文本（见 §3.3）                                                            | `Controller:171`                                                          |
| e   | 汇率表 `dg_huilv` **全字段可手改**（nian/yue/ri/shi/huilv 都是 text 输入），改后影响其后所有换算                | `ExchangeRateController.php:91-99`                                        |
| f   | 发票编辑页**补插** rechargerecord（返金重复记账风险）                                                           | `EditFapiaoController.php:1204-1224`、`EditFapiaoController2.php:839-855` |

### 3.3 ★ 币种与汇率口径（本域最重要的发现，直接推翻既有拍板）

**实测结论：旧系统对客全链路的面值是人民币（CNY），不是日元。** 三组独立证据（本地副本）：

1. 下单扣款与订单面值同币种：`dg_record(action=1)` 与 `dg_order` 配对 284,885 行，**`AVG(-money) / AVG(goodsprice×goodsnum) = 1.0331`**（≈ 1.05 的 5% 服务费口径）；抽样 `-17.65 ↔ 16.80×1`、`-29.19 ↔ 27.80×1`。若余额是 JPY 而货价是 CNY，比值应是 ~0.045 或 ~22。
2. 运单费同量级：`dg_sendorder.totalfee` 均值 774.54、`freight` 均值 460.54，与 `action=3` 扣款均值 -659 同一量级（JPY 计价会是数万）。
3. 充值单据自带换算：`amount`（JPY 原币）÷ 汇率 = `money`（CNY 入账），PayPal 实测 `amount=315,000 → money=14,095.64`（隐含 22.34）；流水文案直接写日文「**元**チャージ」（`uid=14228` 的 `action=9` 行 money 与单据 money **分毫不差**）。

**★ 2026-10-16 复跑补证：`dg_rechargerecord.currency` 不是单值**（本机 34,918 行）：`NULL` 28,362 / `jpy` 5,855 / **`MYR` 701**。三组 `Σmoney/Σamount` = 0.0356 / 0.0459 / **0.0458** —— 前两组是日元量级（NULL 即按日元算），**第三组的比值和日元组几乎相同**：马币按 1 MYR ≈ 1.5 CNY 算，0.0458 差了 30 倍以上 ⇒ 旧系统对 `MYR` 单**大概率直接套了日元汇率**（或 `amount` 记的压根不是马币面值）。这是 #11a「资金安全缺陷」清单里新的第 7 条，回填不修数据、按 `rate_source='LEGACY_DERIVED'` 原样落库并登记 `RATE_DRIFT`。同时定版：`sourceCurrency` **不许硬编码 JPY**，取 `UPPER(COALESCE(NULLIF(currency,''),'JPY'))`。

**唯一是 JPY 的两处**：`dg_rechargerecord.amount`（原币入金）、`dg_users.monpayamt`（注释「月额会员每月扣费**日元**」，默认 30000）→ 说明**月额会员扣费这条链路必然有一次换算**，而换算结果同样进 CNY 余额。

**汇率基础设施**（确证）：

| 项          | 事实                                                                                                                                                                                                                                                                                                                                                  | 位置                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 汇率表      | ★ **`dg_huilv`**（`hid / nian / yue / ri / shi / fen / huilv float(10,2) / addtime`）——**按年月日时**粒度的汇率时间序列                                                                                                                                                                                                                               | `taotaro.sql:1460-1470`                                                               |
| 汇率来源    | 先查 `dg_huilv` 命中当小时 → 否则**爬三菱银行 +0.5 点** → 否则**爬 Yahoo +0.8 点** → 否则取 `dg_huilv` 最新一条 → 全部失败**返回 0**                                                                                                                                                                                                                  | `app/Libraries/Currency.php:165-198`                                                  |
| 写入 Job    | 每小时整点 `firstOrCreate`（`fen` 恒 0），缓存 3 分钟                                                                                                                                                                                                                                                                                                 | `app/Jobs/ProcessSyncCurrency.php:29-59`、`Console/Kernel.php:81`、`Currency.php:148` |
| 支持币种    | 仅 USD / CNY / JPY / GBP                                                                                                                                                                                                                                                                                                                              | `Currency.php:31-41`                                                                  |
| 汇率快照    | ★ **单据与流水都没有汇率列**；事后只能用 `amount/money` 反推（`RechargeRecord::calculateChargeRate()` `:166-184`），但 PayPal/Stripe 反推出来的是**含手续费的比率不是汇率**（PayPal 建单 `(amount*0.964-40)/rate` vs 回调 `amount-(amount*0.036+40)` **两套算法不自洽**：`GetPaypalTransferConfigQuery.php:88-92` vs `PaypalController.php:109-110`） | —                                                                                     |
| 汇率藏文本  | 银行入账把汇率拼进流水备注：`'銀行振込, レート：23.4'`                                                                                                                                                                                                                                                                                                | `Repositories/.../RechargeRecord.php:98-101`（实测 `rid=7019792`）                    |
| `floatrate` | ★ **死列**：`dg_users.floatrate decimal(10,2) default 0.05`「对客浮动汇率」全仓**唯一出现处是后台详情页展示**（`UserController.php:384`），无任何金额计算读取；真实浮动是 `+0.5 / +0.8` 硬编码加点                                                                                                                                                    | `taotaro.sql:2329`                                                                    |

**⇒ 三条后果（必须处理，不是建议）**：

1. ★ **`member-schema.md` Q3「余额 = JPY + Decimal(12,2)」判错，已改判（2026-10-15 拍板，§八 Q1）**：回填若按 JPY 写入而源数据是 CNY，余额静默放大 ~22 倍；「另建 JPY 账本 + 换算回填」的替代方案被否，因为它让新旧余额不同单位、**同库同事务双写无法比对**（member-迁移与共存.md §4.3 的读新写双会立刻穿帮）。→ 新系统 `accounts.currency` 默认 **CNY**，JPY 只作原币入金与展示层换算。
2. **`order-schema.md` §五注释「对客单价 JPY（旧 goodsprice）」是错的**（`goodsprice` 与 `goodsuprice`「商品采购价」`taotaro.sql` 同列组，两者都是 CNY；对客 vs 采购成本才是它的真实维度）。按 docs/07 §6.3 三方防漂移，注释必须订正，否则后续域继续抄错。
3. **汇率对账（docs/02 §5.3 第 5 类）在旧库无任何可比对原料** → 新 ledger 必须自带 `rate` + `rate_source` + `rate_snapshot_at` 三列，且 `dg_huilv.huilv` 的 `float` **必须升 `Decimal(12,8)`**。
   > ⚠ **2026-10-16 实测订正本条的理由**（结论不变、论据换了）：`huilv` 实际值域 **15.46 ~ 24.07**（2019→2026 逐年抬升，76,623 行 / 55,732 个时刻），存的是「**1 CNY = X JPY**」，不是 0.045 量级的 JPY→CNY。所以精度损失不在「存储只剩 2 位」，而在**取倒数落账**那一步（1/23.4 的二进制浮点误差直接进 `money`）；升 `Decimal(12,8)` 依然必要，但方向反过来才说得通。

### 3.4 `finance_order_cash_flow`——采购侧资金流水（102 万行）

`taotaro.sql:2451-2467`（列定义见 docs/plans/01 §九，本文补实测）：

- 实测 880,906 行（本地）；`AUTO_INCREMENT=1020212`（生产）。
- ★ **`change_type` 实测只有一个值 `1`**（647,567 + 237,086 = 全表）→ **TODO #3b 的本项可以收口：该列不是词表，是历史遗留的单值标记**。旧系统把它建成索引纯属无用。
- `utype` 两值：`0`（647,567 行，`price` 均值 327.88）/ `1`（237,086 行，均值 916.40）。`utype` 与 `dg_users.utype`（默认 0）同名不同义还是同义，需代码确证（§八）。
- `operator` **全非空且非 0** → 这张表是**后台/系统代录入**的采购付款记录，不是会员自助动作。
- 四个金额列各表一义、**无方向无币种**：`price`（用户付款）/ `send_price`（运费）/ `paid_money`（财务付款）/ `bargain_price`（砍价）；`price = paid_money` 仅 163,652/884,653（18%）→ 三列之间存在业务差值但**代码里无恒等式约束**。
- 关联：`relation_order_and_finance_order_cash_flow`（`cash_flow_id` ↔ `oid`，**261 万行**）——一笔流水对多单、一单对多笔，无唯一键。

**诊断**（延续 docs/plans/01 §九）：与 `dg_record` 相比，这张表记的是「**买货花了多少钱**」（成本侧），`dg_record` 记的是「**客户余额怎么变**」（客户侧）。两者是**同一笔交易的两本账**——这正是四方对账里「供应商对账」的原始素材，旧系统却从未把它们比对过。

### 3.5 成本与账单侧的旁表（对账原料）

| 表                                | 行数量级                                                       | 与对账的关系                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dg_airbill`（`taotaro.sql:944`） | 62,998                                                         | ★ `freight`（**对客**国际运费）vs `xyfreight`（**协议**运费）同行并存；`xyweight`/`cweight` 双重量；全 `float(10,2)`                                               |
| `dg_airbillprice`                 | 19,436–19,719                                                  | ★ `agreeprice`（协议价，付货代）vs `price`（收取价，对客）+ `weight float(10,1)`；均值 26,155 → **物流对账的 per-票 成本/收入对照点**                              |
| `v2_platform_order_amount`        | （order 域已建模 `PlatformTradeAmount`，注释即「★ 对账锚点」） | 供应商侧实付回传                                                                                                                                                   |
| `dg_payid`                        | 41（AUTO_INCREMENT=161）                                       | `pid / payid varchar(30) / payabout / uids varchar(255)` —— 像「收款账户 ↔ 会员集合」的**配置表**，`uids` 逗号分隔（order 域 Q1 `payid` 语义未决，本域一并给建议） |
| `relation_bill_and_model`         | 185 行（AUTO_INCREMENT 55→185）                                | 多态 `bill_id ↔ billable_type/billable_id`，注释称 `bill_id` 是「**金额明细表**主键」→ 主表是谁、是否废弃，见 §八                                                  |
| `v2_statistics`                   | 16,934                                                         | `key varchar(64)` + `data text` + `occurred_at` KV 快照，**不是对账表**（无任何比对语义）                                                                          |

### 3.6 账实漂移实测（本域的立项理由）

对本地尾切片跑链式不变式 `accountmoney(第 n 条) = accountmoney(第 n-1 条) + money(第 n 条)`（按 `addtime, rid` 排序，分区到 `uid`）：

| 指标                         | 实测                                                                                                                                            | 含义                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 可比对链环                   | 500,479                                                                                                                                         | 每 uid 首条排除（切片边界）                                                                                                              |
| **链断行数**                 | **36,482（7.3%）**                                                                                                                              | 流水金额 ≠ 余额快照差值                                                                                                                  |
| **受影响会员**               | **919 / 1,684（55%）**                                                                                                                          | 过半会员的余额链条有断点                                                                                                                 |
| 断点归因                     | `action=1`（下单扣款）占 **35,977 行（98.6%）**，累计绝对偏差 **2,320,445.90**；`action=4` 357 行；`action=13` **82/185 行（44%）**             | **断点集中在下单扣款**——扣款金额与实际扣减的余额长期不一致                                                                               |
| 期末快照 vs `dg_users.money` | **673 / 676 会员相符**（切片内 uid 在 `dg_users` 副本中存在的）                                                                                 | ★ 关键结论：**期初期末对得上，中间流水对不上**——旧系统只保证「最终余额」，不保证「每笔流水可追溯」。对账必须**逐环校验**，不能只比期末数 |
| 方向违规                     | 82 行（`type=1` 却为正 / `type=2` 却为负）                                                                                                      | 方向与金额符号不自洽                                                                                                                     |
| 余额极端值                   | `dg_users.money` max **99,999,350.04**（`decimal(10,2)` 上限 99,999,999.99）；**53 个会员余额为负**，min **-25,064.11**；3,265 / 5,021 余额为 0 | ★ 旧余额列**已经贴着精度上限**（差 65 元就溢出）；透支无守卫，与 docs/07 §3.6「账实漂移即拒」正面对照                                    |

**顺带定位到的「单据↔流水」配对事实**（回填映射的依据，实测 `uid=14228 / 21238 / 21369`）：

- PayPal 充值 `paytype=2 state=2` → 流水是 **`action=9`**（**不是** action=4），money 与单据 money **分毫不差**，remark 模板「Paypalチャージ支払い{x}元チャージ」。
- 后台新建充值单 / 手动扣款审核 → 流水 **`action=0`**（remark 为 NULL、`余额转移`、甚至 `dddd`），实测单行 **+10,000,000.00**、+999,999.00、+50,000.00 —— 与「自由文本 + 无原因码」的黑洞身份吻合。**`余额转移` 说明存在账户间划转**，新 ledger 必须支持双边记账（一借一贷成对）。
- `dg_record` 里 `action=4`（+5,128,523.29 / 29,672 行，均值 +172，remark 嵌 HTML、`oid` 指向 `dg_order.oid`）**是「オーダー削除」= 取消订单退款**（`Services/OrderCancelService.php:66`，词表见 §3.9），与充值无关。
- 累计口径核对：`dg_rechargerecord`(state∈2,3) money 合计 **100,221,527.53**，而 `dg_record action=4` 合计仅 5,128,523.29 —— **若按 DDL 注释把 action=4 当「充值入账」做余额对账，缺口 95%**（真账在 `action=9` PayPal + `action=0` 后台/手动）。这条本身就是「**事件词表读错，对账必然失败**」的实例：旧 `paytype` 的 DDL 注释与 `action` 的实际语义已经不同源（注释正本在代码，§3.2/§3.9）。

> 这组数字就是迁移铁律 4 的实证版：**余额是「被人肉校准过的结果」，不是「流水的累加」**。新系统 ledger 必须做到「链式不变式可由断言脚本验证」，回填时按 §3.6 的口径给出漂移清单而非静默对齐。

### 3.7 抵扣项不入账（已收口）

确证结论：**优惠券抵扣与积分抵扣都不进 `dg_record` 流水**，旧系统的「营销减免」根本不记账。

- `dg_coupon`：所有下单路径把 `couponid/couponMoney` **硬编码 0**（`CreateDfOrderMutation.php:485`、`ConfirmEcommerceOrderService.php:398`、`CreateOrderFromCartService.php:166`、`CreateMemberSendOrderService.php:106`），只有「退回未使用」两处仍在读（`SendOrderCancelService.php:43-45`、`BatchUpdateOrder.php:888-891`），无创建/核销代码 → **事实废弃**。
- `dg_scorerecord`：唯一写入是收货赠分（`ConfirmReceiveSendOrderMutation.php:92` → `User::addScores` `User.php:528-554`），**未发现任何消费/兑换路径**。
- `dg_record` 的 `action=8`「ポイント引替」是**死枚举**（`Record.php:66`，全仓无 `action=8` 的 addMoney 调用）——与 §3.6 的链断统计里「本地切片无 action=2/7/8/12」相互印证。
- 注意区分：`couponFee` / `v2_order_detail.coupon_fee` 是 **1688 供应商红包**，只进采购成本侧（`BatchUpdateOrder.php:687-697`），**与客户余额无关**（order-schema.md 把它列在订单行金额组，别误读成客户优惠）。

⇒ 新系统若继续提供券/积分，必须**自补 ledger 事件类型**（`DISCOUNT_COUPON` / `SCORE_REDEEM`），且它们是否真的动余额（抵扣=少扣 vs 入账=先扣后返）是 §八 Q6。

### 3.8 规模数据（决定回填策略）

| 表                                           | 生产 AUTO_INCREMENT | 本地副本行数                    | 备注                                                                                                     |
| -------------------------------------------- | ------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `dg_record`                                  | **8,073,550**       | 502,163（rid 尾切片 6.5M–7.3M） | 千万级热表，生产在写（切片末 2026-10-08）→ 回填必须**按 rid 分片 + 短事务**，同 order 域 `dg_order` 策略 |
| `finance_order_cash_flow`                    | **1,020,212**       | 880,906                         | 百万级                                                                                                   |
| `dg_rechargerecord`                          | **591,054**         | 34,918（rid 481,984–534,768）   | 本地亦为尾切片                                                                                           |
| `relation_order_and_finance_order_cash_flow` | **2,612,089**       | 220 万                          | 弃用不迁                                                                                                 |
| `dg_record_old`                              | 5,987,115           | **本地无此表**                  | 生产/本地不一致，需 DBA 确认是否已下线（§八 Q2）                                                         |
| `dg_scorerecord` / `dg_bargain_record`       | —                   | 184,224 / 80,467                | 不涉钱，不迁                                                                                             |
| `dg_huilv`                                   | —                   | 待统计                          | 每小时 1 行的小表（汇率时间序列），**必须迁**（汇率对账原料）                                            |
| `dg_refund`                                  | 164                 | 118                             | 废弃，不迁                                                                                               |

时区/时间列：`addtime` 是 INT unix，`created_at/updated_at` 是 datetime——同 order 域 §4.9 处置（`DateTime(0)` + `FROM_UNIXTIME`，注意 +08:00）。
字符集：以上旧表基本都是 **`utf8`(utf8mb3) + utf8_general_ci**，新库 `utf8mb4_unicode_ci`；本域**没有需要 JOIN 的字符串业务键**（`sn`/`remark` 只做展示与检索），但 `gateway_transaction_no`、未来的 `idempotency_key` 若需与 `member`/`v2_*` 列比对，**先按 member 域 collation 坑判定口径**（`member.username` 定 `utf8mb4_general_ci`，禁与其他字符串列 JOIN/UNION）。

### 3.9 `dg_record` 事件词表与幂等实况（旧代码逆向，本轮收口）

**`action` 全量词表**（唯一正本 `app/Models/Record.php:57-82`，日文文案，常量 `:35-55`；后台筛选同源 `DgRecordController.php:138`）：

| action        | 含义                         | 写入点                                                                                                    | 本地切片实测                                                                               |
| ------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 0             | 管理員操作                   | `Repositories/Finance/RechargeRecord.php:57,101`、`Forms/ReviewManualCharge.php:46`                       | 18,359 行（**type=1 -51.4M / type=2 +126.8M**，remark 自由文本）                           |
| 1             | 商品購入（下单扣款）         | `Models/Order.php:2131`(DG)/`:2150`(DF)、`OrderImporterController.php:1686`                               | 381,679 行，**链断 35,977（占全部断链 98.6%）**                                            |
| 2             | 国内運賃                     | **未找到写入点**（词表遗留；国内运费走 order 侧）                                                         | 0 行                                                                                       |
| 3             | 国際運賃                     | `Services/SendOrderPayService.php:62`、`BatchUpdateDFSendorder.php:296`                                   | 26,926 行，全负                                                                            |
| 4             | **オーダー削除（取消退款）** | `Services/OrderCancelService.php:66`                                                                      | 29,672 行全正、均值 +172、`oid` 指向订单 ✓（**修正 §3.6：action=4 是取消退款，不是充值**） |
| 5 / 6         | 価格調整 / 数量調整          | `Order.php:1661`/`:1666` 赋值 → `:1760`                                                                   | 15,029 / 13,876 行，正负都有（改涨改跌）                                                   |
| 7             | 運賃調整                     | **未找到写入点**                                                                                          | 0 行                                                                                       |
| 8             | ポイント引替                 | **未找到写入点** → 死枚举（与 §3.7 互证）                                                                 | 0 行                                                                                       |
| 9             | Paypalチャージ               | `Http/Controllers/Api/PaypalController.php:134`                                                           | 5,945 行全正 ✓ 与充值单据 money 分毫不差（§3.6）                                           |
| 10            | 倉庫保管料（WMS 仓储费）     | `Jobs/ProcessStoreMonthlySettlementJob.php:199`                                                           | 1,019 行全负                                                                               |
| 11            | 値引交渉（已邮寄返砍价）     | `EditFapiaoController.php:1211`、`EditFapiaoController2.php:839`、`BatchUpdateDFSendorder.php:316`        | 9,462 行全正                                                                               |
| 12            | その他 → **月会員費**        | `Jobs/ProcessMemberFeeDeductionJob.php:146/164`、`PayNextMonthMemberFeeMutation.php:107`                  | **本地切片 0 行** → 需生产复核（§八 Q7）                                                   |
| 13            | AI機能を使用                 | 有常量 `:43`，**未找到写入点**                                                                            | 185 行、正负互现、**44% 链断** → 疑似旁路/测试                                             |
| 14–20, 22, 23 | **OEM 专属**                 | 仅由 `Record::resolveOemAction()` `:112` 按 `paytype` 映射（`:100-110`），入口 `RechargeRecord.php:47-49` | 各 1–2 行（OEM 测试户，正负互现）                                                          |
| 21            | Stripeチャージ               | PHP 侧**未找到**（推测 Python 网关）                                                                      | 0 行                                                                                       |

**★ OEM 专属 action 全语义（#11f 已于 2026-10-18 读码收口，正本 `app/Models/Record.php:98-115`）**：`resolveOemAction()` 是 `dg_rechargerecord.paytype` → `dg_record.action` 的**固定映射**（`$oemPaytypeActionMap` `:100-110`），方向是「按单据上的费项原因决定账本原因码」：

| paytype（单据费项） | action | 日文标签（`$recordAction` `:57-82`） | flow_type（已落入 `0017` `_t1_flow_type_map`） |
| ------------------- | ------ | ------------------------------------ | ---------------------------------------------- |
| 3 商品購入          | 14     | 管理員操作-OEM-商品購入              | `OEM_PURCHASE_DEBIT`                           |
| 5 国内運賃          | 15     | 管理員操作-OEM-国内運賃              | `OEM_DOMESTIC_FREIGHT`                         |
| 4 国際運賃          | 16     | 管理員操作-OEM-国際運賃              | `OEM_INTL_FREIGHT`                             |
| 7 倉庫保管料        | 17     | 管理員操作-OEM-倉庫保管料            | `OEM_WAREHOUSE_FEE`                            |
| 11 その他           | 18     | 管理員操作-OEM-その他                | `OEM_OTHER_FEE`                                |
| 8 オプション料金    | 19     | 管理員操作-OEM-オプション料金決済    | `OEM_OPTION_PAYMENT`                           |
| 12 撮影費用         | 20     | 管理員操作-OEM-撮影費用              | `OEM_PHOTO_FEE`                                |
| 6 賠償              | 22     | 管理員操作-OEM-賠償                  | `OEM_INDEMNITY_PAYMENT`                        |
| 10 取引中止         | 23     | 管理員操作-OEM-取引中止              | `OEM_TRADE_STOP`                               |

**三条行为语义**（新系统对账/审计必须知道）：① **角色门**——只有提交/操作后台的管理员带 `oem_business_manager` 角色时才走 OEM 映射，否则一律 `action=0`（管理員操作）；两个写入点都遵守：`Forms/ReviewManualCharge.php:42-46`（人工充值审核通过）与 `Repositories/Finance/RechargeRecord.php:47-49`（后台直接创建充值单）。② **paytype=10（取引中止）带账户副作用**——创建路径（`RechargeRecord.php:59-62`）在入账之外还置 `dg_users.orderenable=0` + `stoptime=now()`（禁止交易），**审核路径没有这个副作用**——两路径行为不对称，R1/R2 收口时要么对齐要么显式登记。③ paytype 未命中映射表时兜底 `action=0`（`:112` `?? RECORD_ACTION_0`）——即 OEM 单据永远有原因码，不会掉进 `LEGACY_UNKNOWN_ACTION`。

⚠️ 三条排除项：`OrderController.php:3339-3400` 的数字是 **admin_operation_logs.detail_action**，与本表无关；`RecordOld.php:43-58` 是 **0–12+21 的旧词表**（无 13/14–20/22/23）——是词表演化的证据；docs/00 §三 称「Finance 业务文档 0 篇」**不实**：`backend/docs/business/` 实为 67 篇，其中 finance 相关 **4 篇**（`finance-orders-bargain-amount-warning.md`、`stripe-recharge-integration.md`、`worldfirst-quota-accumulation.md`、`ecommerce-order-confirm-balance-check.md`，另 `overdue-order-dingtalk-notification.md`）。

**词表给新模型的直接结论**：① `action` 是**业务原因**（12 个有效值 + 8 个 OEM 专属 + 4 个死值），映射 `flow_type` 一一对应即可；② `action=0` 独占 176M 的进出量且无原因码，**是最大的对账盲区**（§4.4）；③ `type` **是 `money` 符号的派生冗余列**（由 `User.php:490-496` 现算，`money=0` 落 `type=1`）→ 新模型里 `direction` 表达**记账意图**（命令入参）、`signed_amount` 是结果，两者冲突即拒绝入账，**不允许任何一方被独立改写**（旧库 82 行方向违规就是两列各自可写的后果）。

**`accountmoney` 为什么不可信**（§3.6 那 7.3% 断链的成因，确证）：

```php
// User.php:485-488（唯一写入处）
DB::connection(...)->beginTransaction();
$accountmoney = $this->money + $money;   // ← 旧值来自【内存快照】
$this->increment('money', $money);       // ← 原子 UPDATE，但【无 WHERE money >= X 守卫】
```

调用方不加行锁时快照即陈旧（`Order.php:1760` 用的是 eager-load 的 `$model->user`）；只有加锁路径（`SendOrderPayService.php:45-47`）才正确。这解释了断链集中在 `action=1`。`increment` 无下限守卫 → 月费/仓储费两个 Job **无锁无校验**（`ProcessMemberFeeDeductionJob.php:164`、`ProcessStoreMonthlySettlementJob.php:199`）可把余额扣成负数 → 实测 53 个负余额账户。

**幂等实况**（§4.3 的依据）：

| 机制                                              | 实况                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dg_record.idempotency_key` UNIQUE                | **无 migration、全仓零读写**，仅 `taotaro.sql:1889-1891` 有列 → **DBA 手工加列**，历史行必 NULL（UNIQUE 允许多 NULL）。**不能当「已验证实践」引用**                                                                                                                                                             |
| `dg_record.sn`                                    | 真正在用的 `dg_record ↔ dg_rechargerecord` **唯一 JOIN 键**（`Record.php:129`），但生成规则 `date("YmdHis").random_int(100,999)`（`RechargeRecord.php:96`、`BatchUpdateDFSendorder.php:315`、`EditFapiaoController.php:1207`）→ **含随机数，非幂等**                                                            |
| `dg_rechargerecord.gateway_transaction_no` UNIQUE | PHP 侧零引用；只有 `stripe-recharge-integration.md:64,262,296-302,405` 规定由 **Python MQ Consumer** 写并作幂等键（`SELECT ... WHERE gateway_transaction_no=? AND state=1 FOR UPDATE` + UNIQUE 兜底）                                                                                                           |
| 现存「软幂等」                                    | 全是**先查后插**：`remark LIKE '月会員費'` + 当月窗口（`ProcessMemberFeeDeductionJob.php:229-243`）、`hasBargainRefundRecord()`（`BatchUpdateDFSendorder.php:310`）、`RechargeRecordReviewAction.php:88` → 新系统唯一键设计的**反例清单**                                                                       |
| `sn` 三义混用                                     | ① 充值/退款凭证号（17 位伪单号）② 国际物流/运单号（`SendOrderPayService.php:62` 传 `sendOrder->sn`）③ 多数扣款传 `""`（`Order.php:2131/1760`）。500 长度**无代码依据**（现网最长写入约 30 字符，且无任何代码把订单号列表拼进 `sn`；`dg_sendorder.sn` 才是 varchar(2550)）→ 新库拆 `voucher_no` / `logistics_no` |

**`dg_record_old` 定性**（收 §八 Q2）：**已停写、纯只读归档**——全仓仅 4 处引用（`Models/RecordOld.php`、`Admin/Controllers/Finance/DgRecordOldController.php`、`Repositories/Finance/DgRecordOld.php`、`routes.php:163` 路由 `finance/user-bills-old`），**无任何写入点**；DDL 无 `vip/extend/idempotency_key`（`taotaro.sql:1899-1918`），`AUTO_INCREMENT=5,987,115`。`dg_record` 由 migration `2023_03_06_101756` 新建（该 migration 也无 `vip/extend/idempotency_key`，且 `dg_record.vip` **代码零读写 = 死列**，与实测「vip 全 0」互证）。★ **两表 `rid` 各自自增 → 数值空间重叠**，合并进一张 `ledger_entries` 时 `id = rid` 的对齐策略会撞号（§五 已改）。

---

## 四、关键建模决策（逐条给理由）

### 4.1 记账范式：**账户制单式流水 + 余额快照**，不建复式科目树

| 方案                                     | 取舍                                                                                                                                                                      | 结论                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 复式借贷（DR/CR + 科目表 + 试算平衡）    | 财务严谨，但需要有人懂会计；团队是 Java 背景接手，docs/00 已说 Finance 是**知识黑洞**（旧系统 0 篇业务文档）                                                              | ❌ 重演旧系统命运：没人维护的科目表 3 年后变成第二个 `dg_record` |
| 单式流水（照搬 `dg_record`：一行动一条） | 最简单，但 §3.6 已证明「余额转移」这类**双边动作**单式记会漏一侧                                                                                                          | ❌ 不满足对账                                                    |
| **账户制单式流水**（推荐）               | 每个动钱动作 = 1~2 条 `ledger_entries`，**每条挂一个 `account_id`**；内部划转产生成对两条（一出一入），靠 `pair_key` 配平校验。有「多张账户」的收益，无「会计科目」的成本 | ✅ **采纳**                                                      |

账户集合（初版 6 类，够用即止）：`MEMBER`（会员余额，一人一户）、`COMPANY`（平台收入）、`PURCHASE`（采购成本）、`FREIGHT`（运费）、`CHANNEL_IN_TRANSIT`（渠道在途）、`ADJUSTMENT`（人工调整损益）。会员侧只关心 `MEMBER`，其余为对账侧账户。

### 4.2 余额正本三层结构（落地 docs/07 §3.1「唯一写入口」）

```
accounts                    守卫行：balance / currency / row_version
   ↑  ledger.post(command)  —— 本域唯一动钱方法，类头注释写死「禁旁路 update」
ledger_entries              append-only：signed_amount / direction / balance_after
   ↓  同事务投影            （可全量重建，非正本）
member.balance              缓存列（member-schema.md §3.1 的判断在此兑现）
```

- **`balance_after` 保留并升级为不变式**：旧 `accountmoney` 是正确实践的半成品——它存了快照但**从不校验**，于是 §3.6 的 7.3% 断链无人知晓。新系统在 `post()` 内同事务断言 `balance_after = 上一条.balance_after + signed_amount`（首条 = 期初），违反即**拒绝动账并回滚**（docs/07 §3.6「账实漂移即拒」）。
- **守卫下 SQL**：扣款走 `UPDATE accounts SET balance = balance - {delta} WHERE id = ? AND balance >= ?`，`count=0` 时回查区分「行不存在（首建 upsert）」与「余额不足（业务异常带当前值）」——docs/07 §3.3 原文照做。旧系统实测 **53 个会员余额为负（min -25,064.11）**，就是没有这道守卫的直接后果。
- **锁序单向**：`order` 域 confirm 是 `ecommerce_order → dg_users`，send-order 支付是 `sendorder → user`（两域计划书已记）。本域统一为 **`业务单据 → account`**，`ledger.post()` 内禁再取其他锁；账户间划转按 **`account_id` 升序**取 `SELECT ... FOR UPDATE`（docs/07 §3.5 防死锁）。

### 4.3 幂等键**必须真正启用**（旧系统 100% NULL 的教训）

- `ledger_entries` 建 **`UNIQUE (account_id, idempotency_key)`**；键 = 业务事件确定性构造 `{flowType}:{bizType}:{bizId}:{occurrence}`（`occurrence` 处理同单多次改价这类合法重复）。
- 撞唯一键 → **读回首次那条并返回其结果**，禁二次记账（§3.2 PayPal「2 秒 Cache::lock + state==2 则 return」的先查后改，是本项目最可能发生的资金事故形态）。
- 旧系统已在用的文本判重（`Record` 的 `remark LIKE '送り状 {sid} 商品'`，send-order-schema.md:165）→ **由结构化幂等键取代**，`remark` 不再承担幂等职责。
- 同步修 `dg_rechargerecord.gateway_transaction_no` 的教训：**列建了不等于在用**（生产有列、代码 0 引用、本地副本无列）。任何幂等列必须有写入点 + 断言校验（非 NULL 率）。
- ★ 三条确证的「假幂等」反例（详见 §3.9），新系统必须逐条封堵：① `dg_record.idempotency_key` **是 DBA 手工加的空列**（无 migration、代码零读写）；② 真正在用的关联键 `sn` 由 `date("YmdHis").random_int(100,999)` 生成——**含随机数，重复调用必产生新值**；③ 现存判重全是「先查后插」的文本匹配（`remark LIKE '月会員費'` + 当月窗口、`hasBargainRefundRecord()`），并发窗口内必然重复入账。
- 唯一键的**取值域**也要断言：`{occurrence}` 由发起方（order/send-order service）在业务事务内计算并传入，finance 侧不做「查历史算序号」（那是先查后插的另一种形态）。

### 4.4 事件词表拆成 `flowType`（原因）× `channel`（渠道）两维

旧 `paytype` 一列混装「入金渠道」与「费用类型」（§3.2），旧 `action` 一列混装「方向线索」「业务原因」「黑洞 0」。新模型：

- `flow_type`（原因，必填枚举，词表正本在 `packages/contract/src/domains/finance.ts`，docs/07 §2.4 演进只加不改）
- `channel`（渠道，可空枚举：`BANK_TRANSFER` / `PAYPAL` / `STRIPE` / `INTERNAL_TRANSFER` / `MANUAL` / `ORDER_OFFSET`…）
- `direction`（`IN` / `OUT`）+ `signed_amount`，**两者互相校验**（旧系统 82 行方向违规 = 只靠符号无校验）
- `order_id` / `send_order_id` / `ref_type` + `ref_id`：单据关联走**显式列**，多单关联用 `(entry_id, order_id)` 唯一键的轻量关联表，取代 261 万行无唯一键的 `relation_order_and_finance_order_cash_flow`

`flow_type` 与旧 `action` 的映射表见 **§3.9**（词表已收口：12 个有效业务值 + 8 个 OEM 专属 + 4 个死值）。两条硬结论：

- **`action=0`（管理員操作）不能原样迁成一个 `flow_type`**——它的写入点只有 3 处，且**全部挂在充值/调整单据上**（`Repositories/Finance/RechargeRecord.php:57`（后台手工新建，立即入账）、`:101`（银行初审通过入账）、`Forms/ReviewManualCharge.php:46`（手动扣款审核入账））。→ 拆成 `MANUAL_CREDIT` / `MANUAL_DEBIT` / `ADMIN_RECHARGE` 三个具名值，并且**必须带 `approval_id`（单据号）**；旧库把它记成一条流水而丢掉单据关联（只靠 `sn` 随机号连回去），是 176M 进出量无法归因的根因。
- **死值不入词表**：`action=2`（国内運賃）、`7`（運賃調整）、`8`（ポイント引替）、`13`（AI機能を使用，有常量无写入点、实测 44% 链断）在旧代码里**查不到写入点**，`21`（Stripe）写入点在 Python 网关侧。新 `flow_type` 只登记「有写入点」的 12 个 + 本域自补的（`CORRECTION` / `LEGACY_UNCLASSIFIED` / `LEGACY_MIRROR`）；`13/21` 的历史行按 §6.4 归 `LEGACY_UNCLASSIFIED` 交对账基线。

### 4.5 人工调整：具名原因 + 双人复核 + 禁止改写历史

旧系统三条通路都能让历史流水与当前余额脱钩（§3.2 后门 a/b/c：改汇率反算 money、手改 money/state、批量裸 UPDATE）。新系统：

- **账本不可变**：`ledger_entries` 无 `updated_at`、禁 UPDATE/DELETE（Prisma 层不给方法，DB 层给 DBA 声明）。
- 更正只能**追加反向分录**（`flow_type=CORRECTION` + `corrects_entry_id`），原分录永久留痕。
- 人工调整必须带 `operator_id` + `approval_id`（审核单据）+ `adjust_reason` 枚举；`note` 可选但不得作为唯一说明。
- 汇率不可追溯修改：`exchange_rates` 生效后禁改，纠错走「新增一条 + 汇率对账差异」。

### 4.6 币种与汇率（由 §3.3 的实锤驱动，本域最大改动）

- 所有金额列带 `currency`；`ledger_entries` 带 `rate`（换算率）、`rate_source`（`HUILV` / `MANUAL` / `GATEWAY`）、`rate_ref_id`（指向 `exchange_rates.id`）三列——**换算是账本事件的一部分，不是文本备注**。
- `exchange_rates`（源 `dg_huilv`）：`base`/`quote`/`rate Decimal(12,8)`/`effective_at`/`source`/`added_by`。★ **方向按实测定为 `base=CNY` / `quote=JPY`**（值域 15.46~24.07，见 §3.3 订正）。
- ⚠ 旧表 `GROUP BY (nian,yue,ri,shi,fen)` 后是 **55,732 个时刻 / 76,623 行**（同一分钟最多 95 条）→ `@@unique([base,quote,effective_at])` 必然撞，回填**只能有一条取胜**：定版取 **`MAX(hid)` 那条**（后写覆盖先写，与旧库读取顺序一致），折叠掉的 20,891 行登记成 `reconciliation_diffs(DUPLICATED_ENTRY)`，**不许靠 ODKU 静默吞**。
- **`dg_users.floatrate` 判死列**（确证：全仓仅后台详情读它，无任何计算读取）→ 新系统**不迁**（`member-schema.md` / `schema.prisma:103` 的 `floatRate` 须移除或改名 `legacyFloatRate` 仅作审计，见 §八 Q3）。真实浮动加点（+0.5 / +0.8）归 §4.10 `FeeRule`。

### 4.7 不做冻结/预扣（已确证旧系统无此概念）

逆向结论：全仓 `冻结|freeze|locked_money` **只命中 MNS payload 注释**，`dg_users` 也无冻结列；模式是「**校验后立即扣**」，单一入口 `User::addMoney()`（`User.php:478-526`，全仓无 raw `update(['money'])` 绕过）。但**校验散落调用方**：`SendOrderPayService.php:54`、`ConfirmEcommerceOrderService.php:175-210` 有 `lockForUpdate`，而 `Order.php:1756` **未锁**、月费/仓储费两个 Job **无锁无校验**（§3.9）。

⇒ 三个决策：① **不加 `lockedAmount`**（旧口径没有，加了反而无法与旧库双写比对；会员侧「余额不足」体验靠守卫即时失败）；② 把「校验下 SQL」当成**迁移的主要收益**——`balance >= ?` 守卫收进 `ledger.post()`，调用方不得自带校验（消除 6 处散落校验 + 53 个负余额）；③ **`accounts.row_version` + `SELECT ... FOR UPDATE` 必须在同一个数据库事务里取账户行**，禁止像旧系统那样依赖调用方是否记得加锁（`accountmoney` 断链的成因即「内存快照」，§3.9）。

> 唯一需要留意的隐性「冻结」语义：充值**初审通过就加钱**（§3.2/`RechargeRecord.php:88-101`），「完成核对 3→2」不再动账 → 审核期间钱已在余额里、但银行到账还没核。这不是冻结，是**入账时点前置**的资损风险，切写前必须封堵（已登记 TODO **#11a**），新系统改为「银行流水核对通过才 `ledger.post()`」，初审只做登记。

### 4.8 采购侧流水并入账本（`finance_order_cash_flow`）

- **`change_type` 词表确证只有 `1 付款 / 2 退款`**（`FinanceOrderCashFlow.php:27-28` + 后台 `FinanceOrderCashFlowController.php:62-65`），且实测 880,906 行**全部是 1**、`change_type=2` **0 行** → 写入者只有 `Admin/Forms/BatchUpdateOrder.php:432-433`（批量把「待采购」改「已采购」），`addRefundLog()` **无任何调用方（死代码）**。⇒ **旧系统的「退款侧」从未产生过一条采购流水**，TODO #3b 的 finance 部分到此收口（`dg_users.utype/usetype` 仍挂 #3b）。
- ★ **这张表内部完全自洽**：实测 `paid_money = price − bargain_price + send_price` 在 **884,653/884,653 = 100%** 的行上成立（与代码 `FinanceOrderCashFlow.php:157-160` 的公式一致）。与 `dg_record` 的 7.3% 断链形成鲜明对照——**成本侧记对了，客户侧记错了**。⇒ 该恒等式直接作为新 `ledger_entries` 的**断言基线**（§九 演练清单），且并入时四个金额列可归一：`price`→分录 `signed_amount`，`bargain_price`/`send_price`→伴生列，`paid_money`→**派生不落库**（同 send-order 域「totalfee 禁存历史值」的处置）。
- **两张表不是同一笔钱记两次**：`dg_record` = 客户负债侧**实扣**（含 5% 服务费、会员免手续费等），`cash_flow` = 财务代付动作（`paid_money` **不含服务费与会员折扣**，带后台 `operator`）。两口径**天然对不平**，差值 = 服务费 + 会员减免 + 财务手工调整 → 这正是「供应商对账」与「余额对账」的分界线，新系统用 `flow_type` + 账户（`MEMBER` vs `PURCHASE`）把它显式化，而不是像旧系统各记各的、从不比对。
- `operator` 全非空 → 采购流水是后台代录，故 `ledger_entries.operatorId` 保留可空（会员自助动作无操作人）。
- `utype` 0/1（647,567 / 237,086）与 `dg_users.utype`（默认 0）是否同义仍待代码确证，§八 Q5。

### 4.9 四方对账落表（docs/02 §5.3 的表化）

`reconciliation_batches`（`type` / 窗口 `from_at`–`to_at` / 状态 / 期望总额 / 实际总额 / 差额 / 命中差异数 / 处理人 / `finished_at`）+ `reconciliation_diffs`（`batch_id` / 比对双方业务键 / 期望值 / 实际值 / 差额 / `reason_code` / 处置状态 / 处置人 / `alert_event_id`）。

| 对账     | 左                                                            | 右                                                                          | 已知差异来源（本域实测）                                               |
| -------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 支付渠道 | `recharge_orders`（channel∈BANK/PAYPAL/STRIPE，state 已加钱） | 渠道账单 / `gateway_transaction_no`                                         | `paytype` 混装负向调整；PayPal 双算法；回调重复加钱                    |
| 余额     | `Σ ledger_entries.signed_amount`（含期初）                    | `accounts.balance` 与 `member.balance` 投影                                 | **7.3% 链断**、82 行方向违规、55% 会员有断点                           |
| 供应商   | `ledger(flow_type=PURCHASE_*)` 应付                           | `v2_platform_order_amount` 实付回传、`dg_order.goodsuprice` vs `goodsprice` | `price≠paid_money` 82%；1688 红包 `coupon_fee` 混在成本里              |
| 物流     | `ledger(flow_type=FREIGHT)` 对客                              | `dg_airbill.xyfreight` / `dg_airbillprice.agreeprice`（协议价=付货代）      | 全 `float(10,2)`；保险费在 totalfee 公式外（send-order-schema.md:162） |
| 汇率     | `ledger.rate` 快照                                            | `exchange_rates` 当时生效值                                                 | 旧库**无快照**，只能 `amount/money` 反推且含手续费                     |

- 频率按 docs/02 §5.3（每日/每单/每周），全部落 **worker BullMQ 定时 Job**；差异 ≠0 → `alert_events` + 钉钉；「冻结相关操作」按 docs/02 §5.3 落到 `accounts.status=FROZEN`（人工介入才解）。
- 对账断言脚本化，复用 member/order/send-order 的 `00xx-*-verify.sql` 模式（逐表计数比对，**不能只比期末**——§3.6 已证明那样会漏 7.3%）。

**旧系统到底有什么可复用**（逆向确证）：

| 组件                                                                                                                                                                                                                                                                                                                             | 实况                                                                                                                                                               | 处置                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FinanceStatisticController.php:28-33` + `Repositories/Finance/FinanceStatistic.php:45-122`                                                                                                                                                                                                                                      | 月度总收款/订单收款/运单收款/佣金/**利润率**，**全部聚合 `dg_order`+`dg_sendorder`（应收口径），完全不碰流水与余额**；缓存 1h 且无失效（`:16-17`）                 | 是**统计不是对账**；可作为对账「应收侧一条腿」的口径参考，不进本域表                                                                                                                                  |
| ★ **WorldFirst 系列**：`Models/Finance/WorldFirstCollectionStatement.php`（收款对账单，`remaining`/`used_amount_value`）+ `Services/Finance/MatchWorldFirstCollectionStatementsService.php:25,107,154,224,271,292`（按收款单金额**循环扣减**待提交交易单、超额容差、不足标记）+ `docs/business/worldfirst-quota-accumulation.md` | 旧系统**唯一真正的对账实现**（网关收款流水 ↔ 业务付款单的额度累积匹配），表为 `v2_worldfirst_*`（attachment / collection_statement / notify / statement_recharge） | ★ **作为 `reconciliation_diffs` 匹配算法的范式直接借鉴**（含「容差 + 不足标记」这两个我们原来没想到的细节）；⚠ **dump 与本地副本里都没有 `v2_worldfirst_*` 四张表** → 是否已上线需生产核实（§八 Q13） |
| `Repositories/Statistics/UserConsumeStatistics.php`                                                                                                                                                                                                                                                                              | 用户消费统计                                                                                                                                                       | 报表，不迁                                                                                                                                                                                            |
| 全仓 `reconcile                                                                                                                                                                                                                                                                                                                  | checkBalance                                                                                                                                                       | 对账`                                                                                                                                                                                                 | **未找到任何「Σ流水 = 余额」校验代码** | ⇒ 本域 §3.6 的立项依据成立：新系统是第一个做这件事的 |

### 4.10 费率/汇率规则配置化（收 order 域 Q7、send-order 域遗留）

`fee_rules`：`code`（`SERVICE_RATE` / `DF_HIGH_AMOUNT_MULTIPLIER` / `INSPECTION_MULTIPLIER` / `PAYPAL_FEE` / `STRIPE_FEE` / `BANK_SPREAD_JPY`…）/ `value` / `currency_scope` / `effective_from` / `updated_by`。已知常量与位置：5% 与 `ceil(x*0.05*100)/100`（`Order.php`）、`AMTLIMIT=200` / `AMTLIMITFEE=1.05`、`dffee` 默认 10（会员列，非全局）、PayPal `*0.964-40`（`RechargeRecord.php:16-18`）、Stripe `*0.96`（`:179-181`）、三菱 +0.5 / Yahoo +0.8 加点（`Currency.php:179-190`）。

**规则**：计费只在 `fee-rules` 服务取数，禁在模型层硬编码；每次入账把**使用的规则版本**写进 `ledger_entries.fee_rule_snapshot`（JSON），使「当时按什么算」可回溯。

### 4.11 金额精度定版冲突（§八 Q1 连带）

三处不一致：docs/07 §6.2 写 `Decimal(12,4)`；`utils/money.ts` 注释写「入库对齐 DECIMAL(12,4)」；member Q3 与 order/send-order 已落地的列是 `Decimal(12,2)`。旧库实况：`dg_record.money decimal(12,2)`、`dg_users.money decimal(10,2)`（实测已逼近上限 99,999,999.99 → 99,999,350.04，**只差 64.95 元溢出**）。

**定版（Q8，2026-10-15 拍板）**：本域 `amount` / `balance` / `balance_after` 统一 **`Decimal(14,2)`**（客户面金额 2 位够用——order 域分摊尾差本就是「1~2 **分**」级、无 4 位需求；整数位扩到 14 是为消除 §3.6 的溢出），汇率 **`Decimal(12,8)`**；docs/07 §6.2 与 `utils/money.ts` 注释同步改（本轮已改）。

★ 连带必须一起改的一条：`member.balance` 现在是 `Decimal(12,2)`，它是账本的**投影列**。若账本 14,2 而投影 12,2，余额一旦超过 99,999,999.99（旧库实测已有 99,999,350.04 的账户，只差 64.95 元），投影写入会**溢出报错或静默截断**——所以投影列必须同步升 14,2。**趁 T0 尚未落生产（#3d 待 DBA 写权限），现在改是重生成 DDL；生产建完再改就是 ALTER + 三域回填重跑。**

### 4.12 时间列与主键对齐

- `addtime` INT unix → `DateTime(0)`（同 order 域 §4.9）；`ledger_entries` 用 `occurred_at`（业务时刻）+ `created_at`（落库时刻），二者在补录场景不同，**对账按 `occurred_at`**。
- 主键：★ **`ledger_entries.id` 新分配，不复用旧 `rid`**——`dg_record`（AUTO_INCREMENT 8,073,550）与 `dg_record_old`（5,987,115）**各自自增、数值空间重叠**（§3.9 确证），合并进一张表必撞号。改用 `legacy_source` + `legacy_id` 两列承载对齐与幂等：`('dg_record', rid)` / `('dg_record_old', rid)` / `('finance_order_cash_flow', id)`，配 `@@unique([legacySource, legacyId])`。其余表照旧对齐：`recharge_orders.id = dg_rechargerecord.rid`、`accounts` 新分配（会员户靠 `member_id` 关联，不复用 uid 做 PK）。
- 前三域的「主键对齐旧 id」铁律（member `id==uid`、order `id==oid`、send-order `id==sid`）在 finance **只适用于单据表**（充值单），账本分录表因为「多源合并」例外——这是例外，需在 `AGENTS.md` 速查表说明行里点一句，防后来者照抄。
- **回填必须显式带 `occurred_at` 原值**，禁 `now()`。

### 4.13 钉钉告警：抽掉「一业务一硬编码」

旧系统实况（确证）：

- 封装 `app/Services/Dingtalk/DingtalkWebhookClient.php:13-45`——**只支持 markdown 一种 msgtype**；`:47-63` **HMAC-SHA256 加签**；`errcode != 0` 抛错。
- 配置 `config/services.php:157-171`——**只有一组机器人** `services.dingtalk.overdue_order.*`（webhook / secret / 3 个标题 / cron / queue / chunk），即「一个业务一套硬编码配置」，加第二类告警就要改配置 + 加 cron。
- 在用业务只有一条：超时订单（`Console/Kernel.php:145` 每 30 分钟 → `Jobs/ProcessOverdueOrderDingtalkNotification.php` → `SendOverdueOrderDingtalkNotificationService.php:45-84`，**分块 100 条、3 类**：超时 / 紧急待采购 / 商家未发货）；HTTP 入口 `api/dingtalk/statistics`（`VerifyCsrfToken.php:22` 免 CSRF）。
- ★ **两个「以为是告警其实不是」的坑**：① `finance-orders-bargain-amount-warning.md` 的砍价超 30% 预警是**后台 Grid 红字**（`OrderController::showPayAmt`），**没有任何推送**；② 余额不足告警走的是**会员 webhook**（`Services/Member/Webhook/OrderEventScanner.php:141-158` + `benefit_configs.balance_low_threshold`），也不是钉钉。

⇒ 新设计：`alert_events`（§五）承担**幂等 + 频控 + 重试**，钉钉发送退化为一个 adapter；机器人配置从「env 一组」升级为 **`alert_channels`（webhook/secret 走凭证入口，docs/07 §5.5 AES-GCM，禁入日志）+ `alert_rules`（code → channel + 阈值 + 静默窗口）**；砍价超阈 / 余额不足这类**既有展示又有推送**的场景，规则表里两条记录指两个出口，不再散在 Grid 和 webhook 里。`alert_events.dedup_key` 保证同一条差异在多轮对账里只播一次。

### 4.14 Q1/Q8 定版后的清扫清单（登记 TODO **#11b**，一次成批改）

定版本身只改两个值，但它推翻了前三域写下的口径，**不扫就有人继续抄错**。已核实的落点（行号本轮实测）：

| 文件                               | 位置                                                                                                                                                                                            | 现状 → 应为                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/db/prisma/schema.prisma` | **61 处** `@db.Decimal(12, 2)`                                                                                                                                                                  | → `Decimal(14, 2)`（金额列，Q8）                                                                       |
| 同上                               | `:98-99` `balanceCurrency` 注释「JPY / CNY」+ `@default("JPY")`                                                                                                                                 | → 注释与默认值都改 **CNY**（Q1）                                                                       |
| 同上                               | `:540` order 段头注释「采购成本列（CNY）与对客列（JPY）分组命名」                                                                                                                               | → 两组**都是 CNY**；真实维度是「对客价 vs 采购成本价」                                                 |
| 同上                               | `:625,627,629,631,633,639` 六处「对客单价 JPY / 砍后单价 JPY / 促销价 JPY / 对客运费 JPY / 验货金额 JPY」+ `:625` 双币种分组标题                                                                | → 全部去掉 JPY 字样，改标 CNY                                                                          |
| 同上                               | `:1731-1732` `exchangeRate Decimal(10, 4)`（旧 `exchangerate float(10,2)`）                                                                                                                     | → `Decimal(12, 8)`（汇率定版）                                                                         |
| 同上                               | `:519` `LedgerEntry` 占位模型注释                                                                                                                                                               | 随占位模型整体删除（§五）                                                                              |
| `docs/plans/member-schema.md`      | `:154` Q3「已定：JPY + Decimal(12,2)」、`:164` 下一步同句                                                                                                                                       | → 记「**2026-10-15 改判 CNY**，理由见 finance-schema §3.3/Q1」                                         |
| `docs/plans/member-迁移与共存.md`  | `:133` 拍板 Q3（余额 JPY + 12,2）                                                                                                                                                               | 同上                                                                                                   |
| `docs/plans/order-schema.md`       | `:412`「对客单价 JPY（旧 goodsprice）」及 §五 其它 JPY 注释、§4.2「双币种显式列」表述                                                                                                           | → 对客=采购=同一币种 CNY；双列维度是「对客价 / 采购成本价」                                            |
| `AGENTS.md`                        | 速查表 `packages/db` 状态行仍写「member 域新表正本（17 模型）」                                                                                                                                 | 实为 49 模型（member 17 + order 26 + send-order 6，其中 order/send-order 未提交），加 finance 段后更新 |
| ✅ 已改（2026-10-15）              | `docs/07-开发规范守则.md` §6.2（12,4 → 14,2，补「币种列必带且禁跨币种加减」）、`packages/utils/src/money.ts` 头注释、`AGENTS.md` 技术栈定版表金额行 + `packages/db` 状态行（17 模型 → 49 模型） | 完成                                                                                                   |

**执行实况（2026-10-15，#11b 已完成部分）**：

| 动作                            | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.prisma` 清扫            | **61 处** `Decimal(12, 2)` → `(14, 2)`；另 3 处金额在 `(10, 2)`（`df_fee` / 发票 `bargain_price` / 发票 `send_price`）→ `(14, 2)`；`exchange_rate` `(10, 4)` → **`(12, 8)`**；`balance_currency` 注释 + `default("CNY")`、`charged_currency` `default("CNY")`；**22 处**「JPY（旧 …）」注释 → CNY，order 段头与 `4.2` 分组说明改为「对客价 / 采购成本价（同币种 CNY）」                                                                                  |
| ★ **有意不改的三处 `(10,2)`**   | `member.float_rate`（Q3 死列待处置）、`invoices.order_weight`（重量）、`invoices.low_multiple`（倍率）——**非金额**，盲替换会改错语义；同理 `0011` 里 `CAST(countweight AS DECIMAL(12,4)) * 1000` 是**千克→克**的精度需要，保持不动                                                                                                                                                                                                                       |
| 外部平台币种保留                | `v2_ecommerce_shop.currency default('JPY')`（:938）**不改**——那是 Shopify/Rakuten 等**平台自己的结算币种**，与本系统账本面值无关；`v2_ai_task.cost_currency` 同理                                                                                                                                                                                                                                                                                        |
| 回填脚本                        | `0007:251`、`0008:88/115/117` 四处 `CAST(... AS DECIMAL(12, 2))` → `(14, 2)`；`0012` 汇率注释同步；★ **另发现三处硬写币种字面量** `0002:95`、`0002:166`（`balance_currency`）、`0007:248`（`charged_currency`）`'JPY'` → `'CNY'`——静态扫 schema 看不见，详见 `packages/db/sql/README.md`「口径变更后的复跑清单」                                                                                                                                         |
| 计划书订正                      | `member-schema.md` §3.1/§六/§七（含「日本市场主币 JPY」的错误推断段落重写）、`member-迁移与共存.md:65/133`、`order-schema.md` §4.2 全段 + §五 4 处注释 + `chargedCurrency` 默认值、`send-order-schema.md` 金额组 6 条 + 7 处注释                                                                                                                                                                                                                         |
| DDL 重生成                      | 按段基线截断法重建：`head -535`（member+finance 占位）/ `head -1413`（+order）→ 三次 `prisma migrate diff` 生成 `0001`(17 表) / `0002`(26 表) / `0003`(6 表)，**表数与结构同先前一致**，只有精度与默认值变化                                                                                                                                                                                                                                             |
| **静态验证**                    | 新建空库 `crossbuy_ddlcheck` 跑完整链 `0001 → 0001a → 0002 → 0002a → 0003`：**49 表建成**；`decimal(14,2)` 65 处 / `decimal(12,8)` 1 处 / `decimal(10,2)` 3 处（即上面有意保留的非金额列）；`member.balance_currency` 与 `orders.charged_currency` 默认值实测 `CNY`；`member.username` + 4 个 `tid` 列 `utf8mb4_general_ci` 未被重生成冲掉。`pnpm db:generate` ✓、`pnpm typecheck` 16/16 ✓、`pnpm test`（contract smoke）15/15 ✓。校验后已 drop 该临时库 |
| ✅ **复跑已完成**（2026-10-15） | `crossbuy_dryrun` 重建 49 张派生表 → `0006`/`0010` 刷源 → 三段回填 → 四份 verify → **第二遍计数与金额不变**：Σbalance = Σ`dg_users.money` = 115,263,758.22、砍价 364,598.62、五费 3,050,486.56、历史表行数=实体数、非 CNY 行 0。★ **复跑的最大收获不是「绿」，而是挖出一个 `INSERT..ODKU` 静默吞账号 + 清余额的缺陷**（5 个账号、2 笔余额），已加 fail-fast 守卫——证据与结论见 `03-T1本地演练报告.md` §九                                                | 对本域的警示：`@@unique([accountId, idempotencyKey])` 的 ODKU 只在「同一实体重复投递」时才是对的；凡是**业务键可能属于不同实体**的 UNIQUE（如 username），撞键必须中止而不是 upsert 覆盖 |

★ **时机窗口**：`0001/0002/0003` 三份 DDL 都还**没落生产**（#3d 等 DBA 写权限）→ 现在改只需 `prisma migrate diff` 重生成 + 本地演练重跑；一旦生产建表，同样的改动就是 ALTER + 三域回填重跑。清扫必须**赶在 T0 落库前**。

⚠️ 精度变更不影响存量数值（12,2 → 14,2 是加宽），但本地演练库要重建一遍以验证 `0007/0011` 的 ODKU 与 `ANALYZE TABLE` 步骤仍通过；`packages/db/sql/README.md` 的演练坑位需追加一行「重生成 DDL 后必须整串重跑，不能只跑差异表」。

## 五、Prisma schema 草案（核心模型字段级）

> 规约依据：docs/07 §6.2（每表 `id/created_at/updated_at`、逻辑删除 `deleted`、禁外键、业务唯一键必建）；列名 snake_case 靠 `@map`。
> 本域特例：`ledger_entries` 是 append-only，**故意不给 `updated_at` / `deleted`**（不可变性优先于规约统一），理由写进模型注释。
> ⚠ 现有 `LedgerEntry` 占位模型（DR/CR + 无 account + 无余额快照 + 无业务唯一键）**由本节整体替换**，不是增量补列。✅ 已替换（2026-10-15，落地见 §5.1）。

```prisma
/// 账户行（余额正本挂载点）。本域唯一写入口 ledger.post() 的守卫对象
model Account {
  id            BigInt   @id @default(autoincrement())
  /// MEMBER 会员余额户 / COMPANY 平台收入 / PURCHASE 采购成本
  /// / FREIGHT 运费 / CHANNEL_IN_TRANSIT 渠道在途 / ADJUSTMENT 人工调整损益
  kind          String   @db.VarChar(24)
  /// kind=MEMBER 时 == member.id（== 旧 dg_users.uid）；其余账户 NULL
  memberId      Int?     @map("member_id")
  /// 面值币种。★ 实测旧系统对客链路是 CNY，见 §3.3 与 §八 Q1
  currency      String   @default("CNY") @db.VarChar(8)
  /// 当前余额（守卫列，禁旁路写）
  balance       Decimal  @default(0.00) @db.Decimal(14, 2)
  /// 期初余额 ★ 2026-10-16 改判：= 该户**首条分录的 balance_before**（无分录者才 = 当前余额）。
  ///   原文写「回填 = 旧 dg_users.money」是错的——`money` 是**当前**余额，拿它当期初会让
  ///   `期初 + Σ分录 ≠ 余额` 恒不成立；`money` 只配当 `balance`（0002 已断言 = member.balance）
  openingAmount Decimal  @default(0.00) @map("opening_amount") @db.Decimal(14, 2)
  /// ACTIVE / FROZEN（对账不平即冻结，docs/02 §5.3）
  status        String   @default("ACTIVE") @db.VarChar(16)
  /// 乐观锁行版本
  rowVersion    Int      @default(0) @map("row_version")
  /// 旧 dg_users.last_balance_changed_at
  lastChangedAt DateTime? @map("last_changed_at") @db.DateTime(0)
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(0)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.DateTime(0)

  @@unique([kind, memberId])
  @@index([memberId])
  @@map("accounts")
}

/// 账本分录（append-only，不可变；更正只能加反向分录）。
/// 旧源：dg_record（807 万，客户侧）+ finance_order_cash_flow（102 万，采购侧）
model LedgerEntry {
  id              BigInt   @id @default(autoincrement()) // ★ 新分配，见下方 legacy 两列（§3.9 rid 撞号）
  accountId       BigInt   @map("account_id")
  /// IN / OUT，与 signedAmount 符号互相校验（旧库实测 82 行违规）
  direction       String   @db.VarChar(4)
  /// 带符号金额：IN 正 / OUT 负（旧 money 语义直迁）
  signedAmount    Decimal  @map("signed_amount") @db.Decimal(14, 2)
  /// 动账前后余额快照（旧 accountmoney 的升级版；post() 内断言连续性）
  balanceBefore   Decimal  @map("balance_before") @db.Decimal(14, 2)
  balanceAfter    Decimal  @map("balance_after") @db.Decimal(14, 2)
  currency        String   @db.VarChar(8)
  /// 业务原因词表（正本在 contract；取代旧 action + paytype 的费用侧）
  flowType        String   @map("flow_type") @db.VarChar(40)
  /// 渠道（取代旧 paytype 的渠道侧；可空）
  channel         String?  @db.VarChar(24)
  /// ★ 幂等键 {flowType}:{bizType}:{bizId}:{occurrence}（旧库同名列 100% NULL）
  idempotencyKey  String   @map("idempotency_key") @db.VarChar(128)
  orderId         Int?     @map("order_id")
  sendOrderId     Int?     @map("send_order_id")
  rechargeOrderId BigInt?  @map("recharge_order_id")
  /// 采购侧（旧 cash_flow 一行四金额 → 拆列）。paid_money 是派生值，★ 不落库（§4.8）
  counterpartAmount Decimal? @map("counterpart_amount") @db.Decimal(14, 2) // 旧 price 用户付款
  bargainAmount     Decimal? @map("bargain_amount") @db.Decimal(14, 2)
  freightAmount     Decimal? @map("freight_amount") @db.Decimal(14, 2)     // 旧 send_price
  /// 汇率快照三件套（旧库完全没有，汇率对账的前提）
  rate            Decimal? @db.Decimal(12, 8)
  rateSource      String?  @map("rate_source") @db.VarChar(16) // HUILV / MANUAL / GATEWAY
  rateRefId       BigInt?  @map("rate_ref_id")
  /// 当时用的计费规则（可回溯「按什么算」）
  feeRuleSnapshot Json?    @map("fee_rule_snapshot")
  /// 人工/后台动作的操作人（会员自助为 NULL；旧 cash_flow.operator 全非空）
  operatorId      Int?     @map("operator_id")
  /// ★ action=0 类分录必须挂单据（旧库只靠随机 sn 连回去，§3.9/§4.4）
  approvalId      BigInt?  @map("approval_id")
  adjustReason    String?  @map("adjust_reason") @db.VarChar(32)
  /// 更正分录指向被更正的原分录
  correctsEntryId BigInt?  @map("corrects_entry_id")
  /// 账户间划转的成对键（双边配平校验）
  pairKey         String?  @map("pair_key") @db.VarChar(64)
  /// 人读文案（旧 remark；★ 禁 HTML、禁承担幂等或汇率语义）
  label           String?  @db.VarChar(255)
  /// 旧 `sn` 一列三义（凭证号 / 物流单号 / 空串），拆两列（§3.9）
  voucherNo       String?  @map("voucher_no") @db.VarChar(64)  // ★ 实测 action=10（仓储费）sn 最长 44，32 会截
  logisticsNo     String?  @map("logistics_no") @db.VarChar(64)
  /// 多包裹/多单号场景（旧 dg_sendorder.sn 是 # 连接的 varchar(2550)，同 send-order 域 snExtra 处置）
  logisticsNos    Json?    @map("logistics_nos")
  /// 回填来源与旧主键（dg_record 与 dg_record_old 的 rid 空间重叠，靠这两列定位）
  legacySource    String?  @map("legacy_source") @db.VarChar(32)
  legacyId        BigInt?  @map("legacy_id")
  /// 业务时刻（对账按此列；补录时 ≠ created_at）
  occurredAt      DateTime @map("occurred_at") @db.DateTime(0)
  createdAt       DateTime @default(now()) @map("created_at") @db.DateTime(0)

  @@unique([accountId, idempotencyKey])
  @@unique([legacySource, legacyId])
  @@index([accountId, flowType, occurredAt]) // 旧 idx_uid_action_addtime 的真实口径
  @@index([orderId])
  @@index([sendOrderId])
  @@index([pairKey])
  @@map("ledger_entries")
}

/// 入金单据（旧源 dg_rechargerecord，59 万）。★ 只装「渠道入金」，费用类/负向调整搬去 ledger
model RechargeOrder {
  id            BigInt   @id @default(autoincrement()) // == 旧 rid
  memberId      Int      @map("member_id")             // == 旧 uid
  /// 原币金额（旧 amount，JPY 面值）与入账金额（旧 money，CNY）
  sourceAmount  Decimal  @map("source_amount") @db.Decimal(14, 2)
  sourceCurrency String  @default("JPY") @map("source_currency") @db.VarChar(8)
  creditedAmount Decimal @map("credited_amount") @db.Decimal(14, 2)
  /// ★ 换算依据（旧库无列，只能 amount/money 反推，且 PayPal/Stripe 反推值含手续费）
  rate          Decimal  @db.Decimal(12, 8)
  rateSource    String   @default("HUILV") @map("rate_source") @db.VarChar(16)
  /// 渠道（旧 paytype 拆分后的渠道侧）：BANK_TRANSFER / PAYPAL / STRIPE
  channel       String   @db.VarChar(24)
  channelLabel  String?  @map("channel_label") @db.VarChar(64) // 旧 payname
  /// PENDING(1) / AUDITED(3) / COMPLETED(2) / REJECTED(-1)
  /// ★ 加钱时刻 = 进入 AUDITED（银行）或 COMPLETED（其它），不是「有 successtime」
  status        String   @default("PENDING") @db.VarChar(16)
  gatewayTransactionNo String? @map("gateway_transaction_no") @db.VarChar(128)
  submittedByAdminId   Int?    @map("submitted_by_admin_id")
  auditedByAdminId     Int?    @map("audited_by_admin_id")
  proofAttachmentUrl   String? @map("proof_attachment_url") @db.VarChar(200)
  bankName      String?  @db.VarChar(64)
  payerTel      String?  @map("payer_tel") @db.VarChar(20)
  /// hho / gouba / NULL=yiwutaro（旧 source）
  sourceSystem  String?  @map("source_system") @db.VarChar(32)
  submittedAt   DateTime? @map("submitted_at") @db.DateTime(0) // 旧 addtime
  creditedAt    DateTime? @map("credited_at") @db.DateTime(0)  // 旧 successtime
  /// 加钱分录回填，双向可验（对账第 1 类）
  ledgerEntryId BigInt?   @map("ledger_entry_id")
  notes         Json?
  deleted       Boolean   @default(false)
  createdAt     DateTime  @default(now()) @map("created_at") @db.DateTime(0)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.DateTime(0)

  @@unique([gatewayTransactionNo]) // ★ 渠道幂等（旧库有列但代码 0 引用）
  @@index([memberId, status])
  @@index([status, creditedAt])
  @@map("recharge_orders")
}

/// 汇率时间序列（旧源 dg_huilv）
/// ★ 2026-10-16 实测：值域 15.46~24.07 ⇒ **base=CNY / quote=JPY**；同一分钟最多 95 条 ⇒ 回填取 MAX(hid)
model ExchangeRate {
  id            BigInt   @id @default(autoincrement())
  base          String   @db.VarChar(8)  // JPY
  quote         String   @db.VarChar(8)  // CNY
  rate          Decimal  @db.Decimal(12, 8)
  /// MITSUBISHI / YAHOO / DB_CACHE / MANUAL（旧 Currency.php:165-198 的四级降级链）
  source        String   @db.VarChar(16)
  /// 旧硬编码加点（三菱 +0.5 / Yahoo +0.8）规则化
  spreadApplied Decimal  @default(0) @map("spread_applied") @db.Decimal(12, 8)
  effectiveAt   DateTime @map("effective_at") @db.DateTime(0)
  createdBy     Int?     @map("created_by")
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(0)

  @@unique([base, quote, effectiveAt])
  @@map("exchange_rates")
}

/// 对账批次（docs/02 §5.3 五类；旧系统 0 张对账表）
model ReconciliationBatch {
  id            BigInt   @id @default(autoincrement())
  /// PAYMENT_CHANNEL / BALANCE / SUPPLIER / LOGISTICS / EXCHANGE_RATE
  type          String   @db.VarChar(24)
  windowFrom    DateTime @map("window_from") @db.DateTime(0)
  windowTo      DateTime @map("window_to") @db.DateTime(0)
  /// RUNNING / CLEAN / DIFF_FOUND / FROZEN / RESOLVED
  status        String   @default("RUNNING") @db.VarChar(16)
  expectedTotal Decimal? @map("expected_total") @db.Decimal(14, 2)
  actualTotal   Decimal? @map("actual_total") @db.Decimal(14, 2)
  diffAmount    Decimal? @map("diff_amount") @db.Decimal(14, 2)
  diffCount     Int      @default(0) @map("diff_count")
  handledByAdminId Int?  @map("handled_by_admin_id")
  finishedAt    DateTime? @map("finished_at") @db.DateTime(0)
  createdAt     DateTime  @default(now()) @map("created_at") @db.DateTime(0)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.DateTime(0)

  @@unique([type, windowFrom, windowTo]) // 同窗口重跑幂等
  @@index([type, status])
  @@map("reconciliation_batches")
}

/// 对账差异明细（左=期望 / 右=实际；处置可追）
model ReconciliationDiff {
  id            BigInt   @id @default(autoincrement())
  batchId       BigInt   @map("batch_id")
  leftKey       String   @map("left_key") @db.VarChar(128)
  rightKey      String?  @map("right_key") @db.VarChar(128)
  expectedAmount Decimal @map("expected_amount") @db.Decimal(14, 2)
  actualAmount   Decimal @map("actual_amount") @db.Decimal(14, 2)
  diffAmount     Decimal @map("diff_amount") @db.Decimal(14, 2)
  /// MISSING_ENTRY / DUPLICATED_ENTRY / CHAIN_BROKEN / RATE_DRIFT / AMOUNT_EDITED / STATE_SKIPPED ...
  reasonCode    String   @map("reason_code") @db.VarChar(32)
  /// OPEN / ACCEPTED / CORRECTED / WRITTEN_OFF
  disposition   String   @default("OPEN") @db.VarChar(16)
  handledByAdminId Int?  @map("handled_by_admin_id")
  alertEventId  BigInt?  @map("alert_event_id")
  detail        Json?
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(0)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.DateTime(0)

  @@unique([batchId, leftKey, reasonCode]) // 重跑不重复登记
  @@index([disposition, reasonCode])
  @@map("reconciliation_diffs")
}

/// 费率规则（收 order 域 Q7：5% / 1.05 / PayPal / Stripe / 汇率加点；dffee 留会员列）
model FeeRule {
  id            BigInt   @id @default(autoincrement())
  code          String   @db.VarChar(40)
  value         Decimal  @db.Decimal(12, 8)
  /// PERCENT / MULTIPLIER / FIXED / SPREAD
  mode          String   @db.VarChar(16)
  currency      String?  @db.VarChar(8)
  memberTier    String?  @map("member_tier") @db.VarChar(24)
  effectiveFrom DateTime @map("effective_from") @db.DateTime(0)
  updatedBy     Int?     @map("updated_by")
  note          String?  @db.VarChar(255)
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(0)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.DateTime(0)

  @@unique([code, effectiveFrom])
  @@map("fee_rules")
}

/// 告警事件（钉钉出口；幂等 + 频控，防每轮对账刷屏）
model AlertEvent {
  id            BigInt   @id @default(autoincrement())
  /// LEDGER_CHAIN_BROKEN / RECON_DIFF / NEGATIVE_BALANCE / DUPLICATE_CREDIT / BARGAIN_THRESHOLD ...
  code          String   @db.VarChar(40)
  dedupKey      String   @map("dedup_key") @db.VarChar(128)
  severity      String   @default("WARN") @db.VarChar(8) // INFO / WARN / CRITICAL
  payload       Json?
  /// PENDING / SENT / SUPPRESSED / RESOLVED
  status        String   @default("PENDING") @db.VarChar(16)
  sentAt        DateTime? @map("sent_at") @db.DateTime(0)
  retryCount    Int      @default(0) @map("retry_count")
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(0)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.DateTime(0)

  @@unique([dedupKey])
  @@index([status, createdAt])
  @@map("alert_events")
}

/// 一分录 ↔ 多订单（取代 261 万行无唯一键的 relation_order_and_finance_order_cash_flow）
model LedgerEntryOrder {
  id        BigInt   @id @default(autoincrement())
  entryId   BigInt   @map("entry_id")
  orderId   Int      @map("order_id")
  /// 采购侧金额在本单上的分摊值（旧表把 4 个金额塞一行，此处按需拆到单）
  allocatedAmount Decimal? @map("allocated_amount") @db.Decimal(14, 2)
  createdAt DateTime @default(now()) @map("created_at") @db.DateTime(0)

  @@unique([entryId, orderId])
  @@index([orderId])
  @@map("ledger_entry_orders")
}
```

草案共 **9 个模型**。另有三张表的字段级留待实施时补：§4.13 的 `alert_channels` / `alert_rules`（钉钉机器人配置与规则表，替掉 `config/services.php` 里唯一一组硬编码），§6.2 的 `legacy_sync_watermarks`（镜像水位：源表 / `last_legacy_id` / `last_window_end` / 状态）。

### 5.1 ★ 实施落地记录（2026-10-15，`schema.prisma` finance 段 = **12 模型**）

上面 9 个模型 + 三张待补表已一并落地，DDL 增量脚本 `packages/db/sql/0015-finance-domain-up.sql`（`prisma migrate diff` 生成，12 表、`decimal(14,2)`×18、`decimal(12,8)`×5、13 个 UNIQUE）。**与草案的 6 处 delta**（都是实施时必须定的口径，回写本节以免后来人以为草案即成品）：

| #   | 草案                                  | 落地                                                                                                                                                 | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `LedgerEntry.currency` 无默认         | `@default("CNY")`                                                                                                                                    | Q1 定版后所有面值列一律带 CNY 默认（与 `member.balanceCurrency`、`orders.chargedCurrency` 同构），禁「插入时忘了带币种」                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | `RechargeOrder.deleted Boolean`       | `deletedAt DateTime?`                                                                                                                                | 前三域 49 模型的既有惯例是 `deleted_at`（NULL = 未删，全仓 `deleted Boolean` 出现 0 次），本域不新开第二种软删形态；`docs/07 §6.2` 的措辞已同步订正                                                                                                                                                                                                                                                                                                                                           |
| 3   | 草案未列 `bizNos`                     | `LedgerEntry.bizNos Json?`                                                                                                                           | §6.4 要求「剥标签后 URL 进 bizNos」，草案漏了这个落点列                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | 草案 `@@index` 缺 `recharge_order_id` | 补                                                                                                                                                   | `recharge_orders.ledger_entry_id` 只给单向，按单查分录需要反向索引                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | `Account` 唯一键                      | ✅ **已拍板收口（2026-10-16，#11c②）**：`member_id` 由 NULL 改 **sentinel 0**（`Int @default(0)`），唯一键升为 `@@unique(kind, currency, member_id)` | MySQL 唯一索引里 **NULL 互不相等** → 原键对 COMPANY/PURCHASE/FREIGHT/… 这些 `memberId IS NULL` 的账户完全不设防。依据：`member.id` 恒 ≥ 1（回填后 `AUTO_INCREMENT = max(uid)+1`），0 不可能与真实会员撞号；留 `currency` 在键里是为了「一个 kind 一个币种一个户」，将来多币种记账不必再迁移。**功能实测**：重复插 `(COMPANY, CNY, 0)` → `ERROR 1062 Duplicate entry 'COMPANY-CNY-0'` ✓；`(COMPANY, JPY, 0)` 可插 ✓。⚠ 代价：应用层读到 `member_id = 0` 表示「平台侧账户」，禁把它当会员 id 用 |
| 6   | 三张待补表只有名字                    | 字段级设计已完成                                                                                                                                     | `alert_channels`（`credential_ref` **只存凭证入口引用，禁明文 webhook/secret 入库**，docs/07 §5.5）、`alert_rules`（`@@unique(code, channelId)` 支持「一个 code 两个出口」）、`legacy_sync_watermarks`（`@@unique(source_table)` + `last_legacy_id` 按 rid 单调 + `overlap_count` 左叠 200）                                                                                                                                                                                                  |

占位模型的处置：原 `LedgerEntry`（表名 `ledger_entry`，DR/CR + `Decimal` 无账户 + 无余额快照 + 无业务唯一键）已整体替换，**`0001-member-domain-up.sql` 重生成后不再含它**（16 表）。生产从未建过占位表；演练库若残留，手工 `DROP TABLE ledger_entry` 即可。

草案外待定：`dg_payid` 归 member 还是本域 `AccountGroup`（§八 Q5）；`finance_order_cash_flow.utype` 落 `LedgerEntry.memberKind` 还是留在 order 侧（§八 Q5）；`dg_record_old` 是否并入分录（§八 Q2 已定性「停写归档」，但并入与否是**业务可见性**问题——后台 `finance/user-bills-old` 路由还在给运营看，不并入就得保留旧表只读投影）。

## 六、过渡期共存策略（沿用 Q7：新表正本 + 同库事务双写）

### 6.1 本域最难的一点：**动钱的写入口在切换期有两个**

member/order/send-order 三域的双写都是「新系统写完自己的表，同事务补写旧表的**属性列**」。finance 不同：`dg_record` 与 `dg_users.money` 本身**就是账**，未切换的域（order 587 万热表链路、send-order 已邮寄返金）仍会自己 `addMoney()` 写它。并发两个记账者 = 必然双扣。

**采用「单写者 + 镜像同步」而不是「双边各自记账」**：

| 阶段                                 | 谁是记账者                | 新系统角色                                                                                                                  |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| T1（回填完、order/send-order 未切）  | **旧系统独占**            | `ledger_entries` 只做**镜像投影**（反向同步灌入）+ 跑对账；新系统**不产生** MEMBER 户分录                                   |
| T1.5（某条链路整体切新，如充值审核） | 按 **flow_type 分片**独占 | 该链路 `ledger.post()` 为唯一记账点，**同事务双写** `dg_record` + `dg_users.money`（旧域仍读得懂）；其余 flow_type 仍走镜像 |
| T2（order/send-order 切完）          | 新系统                    | 旧 `dg_record` 降级为只读投影，随域退休（T3）                                                                               |

规则：**一条 `flow_type` 只能有一个写者**，切换以 flow_type 为粒度，禁两条链路同时记账；切换点登记在 `TODO.md`。

### 6.2 反向同步（旧→新镜像）

- 水位表 `legacy_sync_watermarks`（源表 / 上次成功 `last_rid` / `last_window_end` / 状态）。
- 拉取按 **`rid` 单调**（`dg_record.rid` 是 AUTO_INCREMENT，比 `addtime` 可靠——实测同秒多行、补录场景存在），左叠重叠窗口 **N=200 条**（同 docs/07 §5.6 拉单三板斧的「左叠 5 分钟」在 id 轴上的等价物）。
- 幂等：镜像行的 `idempotency_key` 构造为 `LEGACY:{legacy_source}:{legacy_id}`，同时写 `legacy_source` + `legacy_id` 并靠 **`@@unique([legacySource, legacyId])`** 兜底（`dg_record` 与 `dg_record_old` 的 rid 空间重叠，§4.12；旧库那枚 `idempotency_key` 是 DBA 手加的空列，**不可依赖**，§3.9）。重跑天然去重——**不用** `INSERT..ODKU` 撞主键的写法（同 send-order 域历史表 ODKU 翻倍坑：append-only 表必须靠显式唯一键或 `NOT EXISTS` 守卫）。
- 只回填不镜像：`dg_record_old`（已停写，§3.9 确证）、`finance_order_cash_flow`（写入点只有 `BatchUpdateOrder.php:432` 一处，且 8 万+行/年的量级可控）走一次性回填；**只有 `dg_record` 需要持续镜像**。
- 单据↔分录的关联在旧库只有 `sn`（随机号，§3.9），镜像时把它写进 `voucher_no` 并**照原样保留**；新链路（T1.5 后）改为 `recharge_orders.ledger_entry_id` 双向显式关联，不再依赖 `sn`。

### 6.3 双写回旧表必须保持旧侧自洽

新系统写 `dg_record` 时，必须同时给 `accountmoney`（旧侧快照）与 `addtime`，且顺序上**先取旧行锁算快照**——否则旧系统读到的链条会因我们而断（§3.6 的 7.3% 已经够多了）。`dg_users.money` 与 `last_balance_changed_at` 同事务更新，`+08:00` 时区按 order 域 §4.9 口径。

### 6.4 回填与「不修数据」原则

- 807 万行热表：按 rid 分片 + 短事务 + 短连接（同 order 域 `dg_order` 策略）；`uid` 孤儿行按 member 域铁律 `JOIN member` 过滤（本地切片实测 1,684 uid 中仅 676 在 `dg_users` 副本内，**生产孤儿率需复核**）。
- 主键对齐：**`ledger_entries.id` 是新分配的，≠ `dg_record.rid`**（★ 2026-10-15 实施时订正本条：原写「= rid」与 §3.9/§4.12 的 rid 空间重叠结论自相矛盾）。对齐关系统一由 `(legacy_source, legacy_id)` 唯一键承载。单据表仍照铁律对齐：`recharge_orders.id == dg_rechargerecord.rid`；`exchange_rates` 按 `dg_huilv` 时间序列重建（`id` 新分配，旧 hid 记入 legacy 两列）。
- ★ **链断不静默修复**：`balance_after = accountmoney`（原值），`balance_before = balance_after - signed_amount`（推导值）。推导结果与前一条不相等时，**保留原样并登记到 `reconciliation_diffs(reason_code='CHAIN_BROKEN')`**，作为上线前的「已知历史缺陷基线」，禁 UPDATE 旧库（红线 10）。
- `action=0` 的 18,359 行自由文本按关键词粗分（实测可分出的有：`銀行振込, レート：`、`余额转移`、NULL、其它），无法归类的映射 `flow_type=LEGACY_UNCLASSIFIED` 并**计入期初调整科目**，不伪装成具名事件。
- 旧 `remark` 含 HTML 的行（`action=1/4` 模板内嵌 `<a href>`）：迁 `label` 前**剥标签、只留文本与 URL**，URL 进 `bizNos`。

### 6.5 回填的三条硬规矩（2026-10-16 演练踩出来的，写在这儿防第二个人踩）

1. **幂等键只允许一个词表**：`LEGACY:{legacy_source}:{legacy_id}`。
   `0017` 初稿给采购侧写的是 `LEGACY:CASH_FLOW:{id}`，而 `legacy_source` 写 `FINANCE_ORDER_CASH_FLOW` —— 同一来源两套 token，被 `0018` 的 F5 当场判出 **884,653 行 FAIL**。
   配套：`idempotency_key` 要进 ODKU 的更新列，否则改了键格式重跑永远不自愈（旧行留着错键，断言会一直红）。
2. **同一时刻只能有一个回填实例跑同一个库**。`0017` §1 会 `DROP` 重建 `_t1_flow_type_map` 等暂存表，第二个实例正在过程里读它就报 `ER_NO_SUCH_TABLE`。
   2026-10-16 我自己挂了两个后台任务同时跑，第一遍因此在第 5 批中断——**症状像脚本 bug，实为并发**。生产 T1 由 DBA 单实例执行，本条同样适用。
3. **一份数据只允许一条「谁赢」的规则**。`dg_huilv` 同一分钟最多 95 条，`0017` 的 INSERT 当时用 `MAX(huilv)`、ODKU 用 `MAX(hid)` 那条，`0018` 的断言又用第三种写法 → 重跑后 4 行被判「回填与源不符」。
   定版：**取 `MAX(hid)` 那条**（后写覆盖先写），INSERT / ODKU / 断言三处共用同一条 SQL 形态。

## 七、与 contract 的边界

`packages/contract/src/domains/finance.ts`（本域唯一契约出口，遵守 §2：只依赖 zod，禁 ORM 类型）：

1. **词表正本**：`FlowType`（取代旧 `action`）、`Channel`（取代旧 `paytype` 渠道侧）、`RechargeStatus`、`ReconciliationType`、`DiffReason`、`AlertCode`。词表三方对齐（§6.3 防漂移：schema 注释 ↔ 本文 ↔ contract 常量）。
2. **写侧命令**（跨域调用面）：`ledgerPostCommandSchema` = `{ accountId | memberId, flowType, direction, amount: Money, currency, idempotencyKey, refs{orderId?,sendOrderId?}, rate?{value,source}, operatorId?, label? }`。order/send-order 域**只许提交命令**，禁 import finance 的 service/repository（§1.2 模块无横向依赖）。
3. **只读视图**：`LedgerQuery`（`memberId`/`flowType`/`occurredFrom-To`/分页）→ `PageResult<LedgerRow>`；`LedgerRow` 金额一律 `Money` 字符串、出 `balanceAfter`、出 `flowType/channel/label/occurredAt`。
4. **敏感与噪声控制**：
   - `RechargeOrderRow` **不出** `payerTel` / `bankName` / `proofAttachmentUrl`（PII + 凭证，对客与开放 API 均不给）。
   - `feeRuleSnapshot` / `rateSource` 细节属内部：**只在 admin 视图出**，对客契约出「已含服务费」而非费率。
   - 与 send-order 域同款纪律：**不出任何「历史汇总金额」的可信读值**（`totalfee` 教训），对账类数字必须由服务端现算。
5. **member 域的交界**：`benefit_configs.balance_low_threshold`（余额低告警阈值）留在 member，但**读它的是 finance 的告警 Job** → 走 contract 查询，禁跨包 import。`member.balance` 由本域投影，member 域契约保持只读。

## 八、未决问题（需业务/用户确认）

| #              | 问题                                                                                                                                                                                                                                                                                                                      | 影响                                                                                                                            | 本文建议                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1 ★阻塞级** | ~~余额币种口径冲突~~ **✅ 已拍板（2026-10-15）：账本面值 = CNY，与旧库同单位**（实测旧对客全链路是 CNY，member Q3「JPY」判错）。JPY 只留在 `recharge_orders.sourceAmount`、`monpayamt` 与前台展示层                                                                                                                       | 三域已落地注释/默认值须清扫（见 §4.14 清单）；不扫则后来者继续抄错                                                              | `accounts.currency default("CNY")`；双写与对账同单位可比；**禁**再在任何注释写「对客单价 JPY」                                                                                                                                    |
| Q2             | ~~`dg_record_old`（598 万）是否仍在写？是否并入 ledger？~~ **✅ 已收口（§3.9）**：全仓 4 处引用**全是只读**（Model + Grid + Repository + 路由 `finance/user-bills-old`），**无任何写入点** → 纯历史归档                                                                                                                   | 回填范围                                                                                                                        | 只回填**一次**、不纳入 §6.2 镜像同步；`rid` 与主表重叠 → 靠 `legacy_source` 区分（§4.12）                                                                                                                                         |
| Q3             | `dg_users.floatrate` 已判死列，`schema.prisma:103` 的 `floatRate` 怎么处置                                                                                                                                                                                                                                                | 已落地 member 段要 ALTER 或改名                                                                                                 | 改 `legacyFloatRate` 仅审计，禁作计算输入；真实加点归 `fee_rules`。**同类死列新增两枚**：`dg_record.vip`（代码零读写、实测全 0）、`dg_record.idempotency_key`（DBA 手加、零读写）                                                 |
| Q4             | ~~要不要「冻结/预扣」~~ **✅ 已收口（§4.7）**：旧系统**无冻结概念**（全仓 `freeze                                                                                                                                                                                                                                         | locked_money` 只命中 MNS 注释），模式是「校验后立即扣」，校验散落 6 处调用方且 2 个 Job 无锁无校验                              | `accounts` 是否加 `lockedAmount`                                                                                                                                                                                                  | **不加冻结列**（加了无法与旧库双写比对）；真正的充值风险是「初审即入账」，走 #11a 封堵而非冻结 |
| Q5             | `finance_order_cash_flow.utype`（0/1）与 `dg_users.utype` 是否同义；`dg_payid`（41 行）归属                                                                                                                                                                                                                               | `LedgerEntry.memberKind` 列与账户分组建模                                                                                       | `utype` 先当「客户/供应商」二分镜像；`dg_payid` 建议归 member 的收款账户配置                                                                                                                                                      |
| Q6             | 券/积分旧都不入账（§3.7）。新系统若启用，抵扣是「少扣」还是「先扣后返」                                                                                                                                                                                                                                                   | 需新增 flow_type 与对账口径                                                                                                     | 若启用：**先扣后返**（两笔分录，账实可比），禁「少扣」（金额不进账本 = 对账盲区）                                                                                                                                                 |
| Q7             | ~~`action` 词表残余值~~ **✅ 词表已确证**（`Record.php:57-82`，§3.9 全量 21 值）。残余三问：① `action=12`（会員費）本地切片 **0 行**，但有两个 Job 写入点 → 月额会员扣费是否真在跑；② `action=13`（AI機能）**有常量无写入点**却有 185 行、44% 链断 → 谁写的（旁路 HTTP？）；③ `action=21`（Stripe）写入点在 Python 网关侧 | flow_type 映射完整度、`12` 是否入词表                                                                                           | 生产 `SELECT action, COUNT(*) GROUP BY action` 全量复核（datapro 只读可做）；`13` 若查不到写入点则整段归 `LEGACY_UNCLASSIFIED`                                                                                                    |
| Q8             | ~~金额精度定版~~ **✅ 已拍板（2026-10-15）：本域金额 `Decimal(14,2)`、汇率 `Decimal(12,8)`**（docs/07 §6.2 与 `utils/money.ts` 注释原文写 12,4，已同步改）                                                                                                                                                                | 全库金额列 + 已落地三域的 12,2 列                                                                                               | ★ **趁 T0 尚未落生产（#3d 待 DBA 写权限），改 schema 重生成 DDL 成本为 0**；一旦 `0001~0003` 在生产建完再改就是 ALTER + 回填重跑。`member.balance` 必须同步升 14,2，否则账本 14,2 → 投影 12,2 会在 999,999,999.99 处溢出（§4.11） |
| Q9             | 「支付渠道对账」的账单数据从哪来（PayPal/Stripe 报表 API？CSV 导入？）。旧库 0 张账单表                                                                                                                                                                                                                                   | 该对账能否自动化，还是只做「内部一致性对账」                                                                                    | 需业务确认渠道取数方式；未定前**先落地余额/供应商/物流/汇率四类**，渠道对账留接口                                                                                                                                                 |
| Q10            | docs/02 §5.3「对账不平→**冻结相关操作**」的业务边界：冻结账户（禁扣款）还是仅标记差异                                                                                                                                                                                                                                     | `accounts.status=FROZEN` 的触发面与误伤                                                                                         | 只对「差异 > 阈值且非 KNOWN_BASELINE」触发，人工确认后解                                                                                                                                                                          |
| Q11            | 月额会员 `monpayamt`（默认 30000，注释「日元」）每月扣费的换算时点与扣费主体（定时 Job？）归本域哪条链路                                                                                                                                                                                                                  | flow_type + 月度 Job 归属                                                                                                       | 归本域 `MEMBER_MONTHLY_FEE`，worker 定时，`rate` 必带快照                                                                                                                                                                         |
| Q12            | 保险费 `Insurancefee` 在 totalfee 公式外（send-order-schema.md:162），要不要作为独立 flow_type 入账                                                                                                                                                                                                                       | 物流对账口径完整性                                                                                                              | 独立 `INSURANCE_FEE` 入账，禁继续「公式外相加」                                                                                                                                                                                   |
| Q13            | ★ **WorldFirst 收款对账是否已上线**：代码有 4 张 `v2_worldfirst_*` 表的 Model + `MatchWorldFirstCollectionStatementsService`（旧系统唯一真对账实现）+ 业务文档，但 **`taotaro.sql`（2026-10-13 生产导出）与本地副本都没有这 4 张表**                                                                                      | 决定本域 §4.9 是「新造对账引擎」还是「接管既有 WorldFirst 匹配器」；也决定 `dg_record↔rechargerecord↔网关` 三者关系是否已有实现 | 生产核实表是否存在/有无数据；**若在产，其「循环扣减 + 超额容差 + 不足标记」算法直接继承，不另起炉灶**                                                                                                                             |
| Q14            | 充值「**初审通过即入账**」（银行流水核对在后，§4.7）要不要在切写前改成「核对通过才入账」                                                                                                                                                                                                                                  | 这是**业务规则变更**不是 bug 修复：改了会拖长会员可用余额到账时间，运营可能有既定习惯                                           | 需业务确认；未确认前新系统按旧规则镜像，但 `reconciliation_diffs(reason_code='CREDIT_BEFORE_SETTLEMENT')` 先统计敞口金额                                                                                                          |

## 九、下一步

1. ~~先解 Q1（币种口径）~~ ✅ **已拍板（2026-10-15）：账本面值 = CNY**；Q8 同步定版 **金额 `Decimal(14,2)` / 汇率 `Decimal(12,8)`** → 唯一阻塞项解除。★ **但必须先做 §4.14 的清扫（TODO #11b）再落 finance 段**：三域已落地的 61 处 `Decimal(12,2)`、`balanceCurrency default("JPY")`、6 处「JPY」注释不扫，新账本就建在错误口径之上。剩 Q13（WorldFirst 是否在产）不阻塞建表、只阻塞对账算法选型。
2. ~~收口 `action` 词表与余额写入点清单~~ ✅ **已完成**（§3.9：词表全量 21 值 + 写入点 + `accountmoney` 成因 + 幂等实况；§4.7 冻结确证；§4.8 `change_type` 确证）→ 剩 Q7 三个残余值需生产复核。
3. **生产只读通道复核清单**（本地是尾切片，datapro 可做）：① `SELECT action, COUNT(*) FROM dg_record GROUP BY action`（全量，验 Q7）；② `idempotency_key` 非 NULL 率（预期 0%）；③ `dg_record` 全量链断率（尾切片实测 7.3%，需知全量口径）；④ `dg_record_old` 时间跨度与是否仍在涨；⑤ `v2_worldfirst_*` 四表存在性与行数；⑥ `gateway_transaction_no` 非 NULL 率（区分 Stripe 是否上线）；⑦ ★ **新表名重名核查**：`SELECT table_name FROM information_schema.tables WHERE table_schema='taotaro' AND table_name IN ('accounts','ledger_entries','recharge_orders','exchange_rates','reconciliation_batches','reconciliation_diffs','fee_rules','alert_events','alert_channels','alert_rules','legacy_sync_watermarks','ledger_entry_orders')`。**这 12 个名字没做过重名校核**——`docs/plans/00` 是按 6 个前缀（`dg_`/`v2_`/`admin_`/`sys_`/`deprecated_`/`relation_`）分组的盘点，而本域全部是**无前缀名**，盘点证明不了「不存在同名裸表」；前三域的新表都带 `member`/`order`/`send_order` 前缀，是从没踩到过这个问题，不是查过。
   > ✅ **2026-10-16 本机已查**：`taotaro`（本机 160 张）中这 12 个名字**命中 0**，连单数 `ledger_entry` 都不存在；本机 13 张无前缀旧表（`finance_order_cash_flow` / `user_operation_log` / `migrations` / `system_setting` / `t_purchase_*` / `oa_notify*` / `email_task_record` / `failed_jobs` / `0908_*`）也不撞 ⇒ **表名不改**。⚠ 本机 dump 比 `docs/plans/00` 记的 174 张**少 14 张**（`deprecated_` 族本机为 0）⇒ 本条只覆盖 160/174，**生产 T0 前 DBA 仍须复跑同一条查询**。
4. ✅ **已落地（2026-10-15）**：`schema.prisma` finance 段 = **12 模型**（§五 9 个 + 待补 3 表字段级设计完成）+ 占位 `LedgerEntry` 整体替换 + 四份 DDL 重新基线生成 → **`0015-finance-domain-up.sql`**（12 表，增量 diff，禁手改）。⚠ 编号说明：原计划写 `0014-finance-domain-up.sql`，但 0014 已被 `0014-member-source-import.sql`（#3g④）占用 ⇒ 按「全局只增不复用」改为 0015。`0001` 重生成后 16 表（不再含占位 `ledger_entry`），`0002`/`0003` 重生成后**逐字节不变**（证明基线移动没引入漂移）。落地 delta 见 §5.1。
5. ✅ **T1 回填脚本已落地并本地演练**（2026-10-16）：`0016-finance-source-import.sql`（演练源导入）/ `0017-finance-backfill-t1.sql`（**分录 + 单据 + 汇率 + 基线登记**）/ `0018-finance-backfill-verify.sql`（32 项只读断言）。★ **原计划的 `0019` 取消**：把「单据与汇率」从 `0017` 里拆出去会让 §9 的历史缺陷基线拿不到完整分录集（链断数、幂等键、金额配平都必须在同一事务序列内算），拆文件的收益只剩排版，代价是断言失真。`legacy_sync_watermarks` 留给 T1.5 镜像阶段（§6.2），`fee_rules` 是**新系统配置**不是旧数据，不在回填里播种。**★ 前置 #3g 已于 2026-10-16 空库全链跑绿**（证据 `docs/plans/03` §十：T0 四段 60 表零警告 / `0003` 17 PASS + 4 INFO + 0 FAIL / `0005` 24 项 PASS / 守卫两种破坏手法都拦停 / 两遍计数与 Σbalance 不变）⇒ 本域回填可以起跑；另需先跑 §九-⑦①~⑥ 的生产只读复核。
   > ✅ **2026-10-16 本机演练已跑绿**（证据 `docs/plans/03` **§十一**）：`0016` 搬 378 万行 / `0017` 建 **994,279 条分录**（客户侧 Σ **11,388,096.56** = 源、采购侧 Σ **429,587,866.13** = 源）/ `0018` **29 PASS + 0 FAIL + 2 INFO** / 两遍计数与金额全等 / 删一条 flow_type 映射后 F1=342 行立刻 FAIL。★ 演练顺带抓出 **10 个真缺陷**（汇率方向反判、`rate NOT NULL` 与 10,521 行 amount=0 冲突、`voucher_no` 32→64、缺 `legacy_extra`、幂等键两套 token、INSERT/ODKU 取胜规则不一致、缺 `voucher_no` 索引、脚本非并发安全、`openingAmount` 语义错），逐条已修并记在 §6.5 与 03 §11.3。**本域新增断言类型**（前三域没有的）：
   - 链式不变式 `balance_after = balance_before + signed_amount` 逐环计数，期望「断链数 = 已知历史基线」而非 0（回填禁修数据，§6.4）；
   - 方向-符号一致性断言（新表内期望 0 违规）；
   - **派生恒等式断言**：并入采购流水时 `counterpart_amount − bargain_amount + freight_amount` 与分录金额配平（旧表实测 100% 成立，§4.8，是最便宜的正确性哨兵）；
   - 幂等键非 NULL 率 = 100%（旧库 0% 的反面对照）；
   - 镜像水位单调性 + 重跑不增行（`legacy_source+legacy_id` 唯一键兜底）。
6. `packages/contract/src/domains/finance.ts` + 冒烟测试（同 order/send-order 的 15 项模式）。
7. `ledger.post()` 唯一写入口实现（§4.2 三层结构 + §3 守则代码形态）+ 单测；跨域扣费事件接入（order `action=1/5/6`、send-order `action=3/11`）。
8. worker 对账 Job（Q9 未定前落地四类）+ 钉钉告警（`alert_events` 幂等频控）。
9. 更新 `AGENTS.md` 速查表 `packages/db` 状态行 + `docs/plans/README.md` 索引 + `TODO.md`（#3b finance 部分标收口，新增 flow_type 残余值的 `TODO(编号)`）。
