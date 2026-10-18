# send-order 域 schema 设计（精读旧系统后）

> 依据：`docs/plans/order-schema.md`（兄弟域）、`docs/00-原项目参考指南.md`、`docs/07-开发规范守则.md`
> 旧系统精读源（只读）：`haiou/taotaro.sql`（表结构 dump）、`haiou/backend/app/Models/SendOrder.php`（812 行）、`app/Models/Member/SendOrderLabel.php`、`app/Models/Member/SendOrderInvoiceEvent.php`、`app/Services/SendOrderPayService.php`、`app/Admin/Actions/Grid/Sendorder/BatchUpdateDFSendorder.php`、`backend/docs/business/` 下 send-order 相关 9 篇（totalfee 统一改造 + 6 篇开放 API + 2 篇导出）
> 状态：**草案**。对应 TODO **#10**（order + send-order）的第二半；order 域设计见 `order-schema.md`（Q5 已拍板）。
> 共存策略沿用 member 域已定决策（Q7：新表正本 + 同库事务双写），见 `docs/plans/member-迁移与共存.md`。

---

## 一、域边界

### 1.1 send-order 域负责

- **运单主链路**：配送委托运单（`dg_sendorder`，sid 维度）、子运单（同捆，parent_id 自引用）、运单状态机与作业流（prostate）
- **运单金额**：totalfee 五费统一公式（国际运费+增值费+报关费+偏远费+国内运费）、已邮寄扣费与砍价返金（finance 事件的业务侧）
- **运单附属**：客户上传标签（FBA 箱标/商品标/3PL 箱标/运单）、发票事件流、运单增值服务收费
- **开放 API 的运单侧**（`/api/v1/send-orders` 支付/取消/列表/详情/物流/发票，契约归 member 域 webhook 但业务在 send-order）

### 1.2 send-order 域不负责（跨域，禁直接建库关联）

| 域        | 表                                | 边界说明                                                                                                 |
| --------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| order     | `dg_order`                        | 订单行；**关系只存 `orders.sendOrderId` 一侧**（order-schema.md §4.5 已定），禁 `dg_sendorder.oids` 双写 |
| member    | `dg_users` / `dg_address`         | SendOrder 只存 `memberId`；收件人信息是运单**快照**（历史事实，保留）                                    |
| finance   | `dg_record` / `dg_rechargerecord` | 扣费/返金一律 finance 事件（`ledger_entries`）；send-order 只落状态与金额快照                            |
| logistics | `dg_airbill`（10 万行）           | 航空运单轨迹；SendOrder 经 `airbills` 反查（`sendid`），归 logistics 域                                  |
| WMS       | `dg_shelves` / `dg_stores`        | 货架/仓储；已邮寄时 `sid=0` 释放货架是 WMS 动作                                                          |
| email     | `dg_mail` / `EmailTaskRecord`     | 已邮寄通知邮件（`MAIL_TYPE_DF_SENDORDER_SHIPPED`）                                                       |

### 1.3 一条运单的跨域生命周期（总览）

```
dg_order（state=4 已入库，oid 级）
   │ createOrUpdateSendOrderByOrder（oids=单 oid，otype=3，state=1 待处理）
   ▼
dg_sendorder（sid）── paySendOrder ──► dg_record action=3（finance，锁序 sendorder→user）
   │  state 7 待付款 ──支付──► 8 待邮寄
   ▼
BatchUpdateDFSendorder（后台「确认已邮寄并返金」，最重事务）
   │  ├─ addMoney(-totalfee, action=3)        扣国际运费等五费
   │  ├─ addMoney(+refundAmount, action=11)   砍价返金（幂等：bargainstate + Record 兜底）
   │  ├─ RechargeRecord.create                 返金凭证
   │  ├─ dg_shelves.sid=0                      释放货架（WMS）
   │  └─ EmailTaskRecord                       已邮寄通知
   ▼
state 2 已邮寄 ── ConfirmReceive ──► 3 已完成 + 积分（同事务）
   │
   ├── 取消（仅 state=1）：订单回 state=4 + sid=0 + 删运单 + 优惠券复原 + 仓储回改
   └── 发票：dg_fapiao（sid 维度，446 万行）+ v2_send_order_invoice_event（事件流）
```

---

## 二、实体清单与源表映射

| #   | 新实体（Prisma model）       | 目标表名                          | 源表                                | 旧表量级                         | 备注                                                |
| --- | ---------------------------- | --------------------------------- | ----------------------------------- | -------------------------------- | --------------------------------------------------- |
| 1   | `SendOrder`                  | `send_orders`                     | `dg_sendorder`                      | ~67 万（AUTO_INCREMENT 672,867） | 域根实体（sid 维度）                                |
| 2   | `SendOrderStatusHistory`     | `send_order_status_histories`     | — （旧系统无迁移表）                | 新增                             | 替代状态平铺；含 prostate 作业流变迁                |
| 3   | `SendOrderLabel`             | `send_order_labels`               | `v2_send_order_label`               | —                                | FBA 箱标/商品标/3PL 箱标/运单（客户上传）           |
| 4   | `SendOrderInvoiceEvent`      | `send_order_invoice_events`       | `v2_send_order_invoice_event`       | —                                | 发票事件流（append-only）                           |
| 5   | `SendOrderValueAddedService` | `send_order_value_added_services` | `v2_sendorder_value_added_service`  | 36（本地）                       | 运单增值服务收费                                    |
| 6   | `Invoice`                    | `invoices`                        | `dg_fapiao`                         | **446 万行**                     | ★ Q3 建议归本域（sid 维度）；order 域只提供金额快照 |
| 7   | `SendOrderCoupon`            | — （不建表）                      | `dg_sendorder.couponid/couponmoney` | —                                | 优惠券快照留列；券实体归营销域（coupon 域未切片）   |

**明确不建模 / 归他域**：

| 旧表                                                     | 处置                                             |
| -------------------------------------------------------- | ------------------------------------------------ |
| `dg_airbill`（10 万行）                                  | 归 **logistics**（轨迹查询经 `sendid` 反查）     |
| `dg_shelves`                                             | 归 **WMS**（货架；独立项目）                     |
| `dg_send`（7 行，cid/content/subject/var_date/filename） | 疑似站内信模板残留，**不建模**（量微，拍板后弃） |
| `deprecated_dg_sendorder_copy*`                          | ❌ 排除                                          |
| `dg_rechargerecord`（返金凭证）                          | 归 **finance**（ledger 侧凭证）                  |

---

## 三、旧系统 send-order 域全景精读（建模前必读）

### 3.1 `dg_sendorder` 字段分组精读（sid INT PK，本地 ~19,078 行）

**身份/归属**

- `sid` INT PK AUTO_INCREMENT=672,867；`parent_id`（MUL）——同捆子运单指向主运单（本地 51 个子单）
- `sn` **varchar(2550)**——运单流水号（超长，疑历史拼接残留；有 MUL 索引）
- `uid`/`uname`/`memberid`/`email`——会员（uname/memberid 冗余副本，§4.10 不回填）
- `oids` **mediumtext**——关联订单号逗号分隔（关系双写旧账，§4.5 废除）
- `otype` tinyint——1 普通代购 / 3 一件代发（**只有 1 和 3，无 2**；本地 7,220 vs 10,858）

**金额（★ 7 个 decimal(10,2)，totalfee 口径曾双轨）**

- ★ **币种定版（2026-10-15）：本域「对客金额」与「采购成本」同为 CNY**——原判「对客 JPY / 采购 CNY」不成立。实测 `totalfee` 均值 774.54、`freight` 均值 460.54，与 `dg_record` 的国际运费扣款（`action=3`）均值 -659 属同一量级；若对客是日元，这里应是数万级（见 `finance-schema.md` §3.3 与 §八 Q1）
- `freight` 对客国际运费；`ufreight` 采购国际运费（成本）——同一币种下的**对客价 vs 成本价**两个维度
- `serverfee` 增值费；`customsfee` 报关费；`remotefee` 偏远费
- `sendprice` 国内运费（**可为 0 → fallback 到 Σ order.sendprice**；本地 43% 为 0）
- `totalfee` 总费用——**历史双口径**（含/不含偏远费或国内运费），2026-03-19 统一改造（§3.3）
- `Insurancefee` 保险费（**不在 totalfee 公式内**，FinanceStatistic 单独相加 → 是否作为独立账本事件见 `finance-schema.md` §八 Q12）
- `xiwgfei` decimal（损坏/修理费？fillable 但无业务逻辑，Q1 待查）
- `couponmoney` 优惠券金额；`yishouqufee` 已收取费
- `countmoney` 计费金额；`countweight` **varchar(1500)**——计费重（类型错，Q2）
- `storage` decimal 仓储费；`bargainprice`——运单砍价汇总（= Σ order.bargainprice 排除无效态，**与 dg_order.bargainprice 语义不同**，order-schema.md §3.5 已警示）

**收件人快照（历史事实，保留）**

- `consignee`/`country`/`city`/`zip`/`tel`/`address`/`enname`——日本收件人
- `importer_info` **varchar(2048) JSON**——进口商信息（`real_time_account` 报关号码；掩码防护见 §3.7）
- `company_name`——公司名（发票用）

**物流/配送**

- `did`/`deliveryname`/`areaname`——配送渠道（`deliveryname` 值域：直送小包/ZC航空便/ヤマト急便/中国郵政船便/OCS）
- `dfshcode`——代发收货码（已邮寄时清空）
- `passtype` tinyint 通关类型（词表待查 Q3）
- `shipping_warehouse` varchar(20)——发货仓
- `dfsendflag` 0/1 可否发货；`dflwh`/`dfsendtel`/`dfsendaddress`/`dfsendname`/`dfsendinfo`/`dfremarkcn`——代发收件族

**状态与流程**

- `state` 8 态状态机（§3.2）；`prostate` 0-9 作业流（§3.2）；`prostatetime`
- `bargainstate` 0/1 砍价返金状态（本地 5,304 已返金 / 35%）
- `havefapiao` 0/1 发票是否给用户；`fapiaotime`；`invoice_completed_at`/`invoice_completed_type`（1 系统生成/2 人工生成）
- `totalpackages` 包裹数；`packagename`/`packageid`
- `madeinchina_flag` 0-3 贴标规则；`origin_package_choice` 0 废弃/1 保留原包装
- `comment`/`commenttime`/`reply`/`showcomment`——评价（JSON）
- `mailremark` **varchar(1024) 双形态**（纯文本 或 JSON {remark, files}，§3.8）
- `mark_flag` int 位运算（与 order 同款，§4.11）
- `addtime`/`uptime` INT unix

### 3.2 状态机：`state` 8 态 + `prostate` 9 态作业流

**state（SendOrder.php 定稿）**

| 值  | 常量                  | 中文     | 日文           |
| --- | --------------------- | -------- | -------------- |
| 1   | `STATE_WAITING`       | 待处理   | 配送依頼提出済 |
| 2   | `STATE_SHIPPED`       | 已邮寄   | 出荷済み       |
| 3   | `STATE_COMPLISHED`    | 已完成   | 受け取り済み   |
| 4   | `STATE_INVALID`       | 无效运单 | —              |
| 5   | `STATE_PROCESSING`    | 处理中   | 梱包作業中     |
| 6   | `STATE_PENDING_CHECK` | 待审核   | —              |
| 7   | `STATE_PENDING_PAY`   | 待付款   | お支払い待ち   |
| 8   | `STATE_PENDING_SHIP`  | 待邮寄   | 出荷待ち       |

**已核实的迁移**（代码/文档）：

- 建单 → 1（`createOrUpdateSendOrderByOrder` / `CreateDfOrderMutation` / `SplitDFOrderMutation` / 导入）
- 取消：**仅允许 1**（GraphQL `cancelSendOrder` + 开放 API：订单回 `STATE_ARRIVE_CHINA`(4)、`sid=0`、删运单、优惠券复原、仓储回改）
- 支付：**7 → 8**（`SendOrderPayService`：锁 sendorder → 锁 user → 扣 totalfee → 回写；余额不足抛 `USER_INSUFFICIENT_BALANCE`）
- 确认已邮寄并返金：→ **2**（`BatchUpdateDFSendorder`，§3.3 重事务）
- 确认收货：→ **3** + 积分（`ConfirmReceiveSendOrderMutation`，状态与积分同事务）
- 出库（货架出库）：要求 **3**（`SendorderShelfOutAction`）；评价要求 **3**
- ⚠ 旧系统**无迁移表白名单**，5/6 态的写入点未在本次精读中定位全（Q4）——新系统集中定义

**prostate（作业子状态，与 state 并存）**：0 无 / 1 等待同梱 / 2 等OEM商品同梱 / 3 FBA作业中 / 4 等客户指示 / 5 打包中 / 6 有商品找不到 / 7 正在做发票 / 8 拍照中 / 9 缝标中。→ 新系统建模为独立作业流（§4.5），**禁与 state 混为一个枚举**。

### 3.3 金额体系：totalfee 五费统一公式（2026-03-19 改造定稿）

```
totalfee = 国际运费(freight) + 增值费(serverfee) + 报关费(customsfee) + 偏远费(remotefee) + 国内运费(sendprice)

国内运费 sendprice 取值规则（resolveDomesticSendprice）：
  1. dg_sendorder.sendprice > 0 → 用之
  2. 否则 → Σ 关联订单 dg_order.sendprice（仅 >0 的值；排除无效态订单；排除转运单）
```

- **历史病灶**：改造前 totalfee 有两种写入口径（含/不含偏远费或国内运费），同一字段不同数据含义不同；**存量脏数据未回填**，靠业务入口重写收敛
- 统一后所有链路（页面显示/预扣/返金/支付/积分/后台编辑/财务回写/统计/GraphQL）全部改**现算**（`calculateTotalfee()`），关键成功场景回写
- 发票场景例外口径（业务有意为之）：保存发票时运单 `sendprice` 取**发票子项国内运费汇总**，再与运单头四费组成 totalfee
- FinanceStatistic 统计口径：`Σ (Insurancefee + freight + serverfee + customsfee + remotefee + 国内运费)`——保险费在 totalfee 之外
- **已邮寄并返金事务**（`BatchUpdateDFSendorder`，最重）：
  1. 预检（事务外）：sendprice 兜底算 + refundAmount（Σ order.bargainprice 排除无效，<0 归 0）+ totalfee>0 + 余额充足
  2. 事务内：`lockForUpdate` 运单（防重复已邮寄）→ **重算** → `addMoney(-totalfee, action=3, ordflag=DAIFA)` → 回写 state/sendprice/totalfee/**bargainprice**/dfshcode=''
  3. 返金幂等三保险：`bargainstate=1` 跳过；`hasBargainRefundRecord()`（Record action=11 + remark `送り状 {sid} 商品` LIKE）跳过；仅两者皆无且 refundAmount>0 才 `addMoney(+refund, action=11)` + `RechargeRecord.create` + `bargainstate=1`
  4. 事务后：`dg_shelves.sid=0` 释放货架 + 发邮件
- 支付事务（`SendOrderPayService`）：锁序 **sendorder → user**（与 order 域 confirm 的 order→user 同构，防死锁）；`assertLocked` 闭包供开放接口在锁内校验**发票版本**（网站端不传）

### 3.4 关系双写与同捆（bundling）

- `dg_order.sid`（varchar）↔ `dg_sendorder.oids`（mediumtext 逗号分隔）**双向存关系**：解绑要两边改、删运单要回写 sid=0、`deleteSendorderByOids` 还要拆oids/新建运单
- 同捆：`parent_id` 自引用（本地 51 个子运单）；主运单 oids 含全部子单订单
- `dg_shelves.sid`、`dg_fapiao.sid`、`dg_airbill.sendid` 全部按 sid 关联——sid 是跨域关联枢纽
- ➜ 新系统：只存 `orders.sendOrderId` 一侧（order-schema.md §4.5 已定），oids 字符串拆分消亡；同捆改显式 `bundledSendOrders` 关系

### 3.5 标签 / 发票事件 / 增值服务

- **`v2_send_order_label`**（客户上传标签）：type 四种种（`fba_box` FBA箱标 / `fba_item` FNSKU商品标 / `3pl_box` 3PL箱标 / `carrier` 运单）；status 三态（0 received / 1 applied / 2 verified）；`boxes`/`scan_result`/`photo_urls` JSON 数组；`fba_shipment_id`/`destination_code`；软删
- **`v2_send_order_invoice_event`**（发票事件流）：type 两种（`revise_requested` 请求修订 / `paid_confirmed` 已付款确认）；`invoice_version` 版本号；`source`/`ticket_id`（可溯源到工单）；`image_urls`；**append-only**（模型 `UPDATED_AT = null`）
- **`v2_sendorder_value_added_service`**：sid + service_id + name_snapshot + fee + `is_manual`（手工加项标记）

### 3.6 开放 API（契约归 member 域，业务在本域）

| 接口                               | 关键规则                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /send-orders/pay`            | 先 `GET /pay-captcha` 取 6 位数字验证码（Cache 绑定 uid，TTL 300s，一次性）；与 GraphQL `paySendOrder` 同源 |
| `POST /send-orders/cancel`         | 仅 `STATE_WAITING`；副作用同 GraphQL（订单回 4、sid=0、删运单、券复原、仓储回改）                           |
| `GET /send-orders`（列表）         | tokenable 用户名下；state 过滤                                                                              |
| `GET /send-orders/{sid}`（详情）   | —                                                                                                           |
| `GET /send-orders/{sid}/logistics` | 轨迹（ logistics 域）                                                                                       |
| `GET /send-orders/{sid}/invoice`   | 发票（**锁内校验发票版本**——`assertLocked` 闭包）                                                           |

### 3.7 进口商信息掩码防护（#51，报关安全）

- `importer_info.real_time_account`（报关完整号码）**禁存掩码**：保存时若检出掩码（`****1234`），按地址簿（aid）或原值补回完整号码；**掩码对不上 → UserError 拒绝**（2026-10 改严格比对）
- ➜ 新系统：该逻辑归 send-order 保存服务；契约层对 `real_time_account` 做「禁掩码」校验（member 域 Address 已有 `realTimeAccount` 列）

### 3.8 `mailremark` 双形态（文本 or JSON）

- 同一列两种形态：纯文本备注 或 JSON `{remark, files}`（邮件附件路径列表）
- 读写逻辑（get/set attribute）在文本↔JSON 间迁移，保留附件数据不被清理
- ➜ 新系统：拆两列 `mailRemark`（文本）+ `mailAttachments`（JSON 数组），禁双形态列

### 3.9 规模数据（决定回填策略）

| 表                    | 行数（本地副本 / 生产口径）                     | 迁移注意                         |
| --------------------- | ----------------------------------------------- | -------------------------------- |
| `dg_sendorder`        | 19,078 / AUTO_INCREMENT 672,867（生产约 67 万） | sid 主键对齐；双写同库同事务     |
| `dg_fapiao`           | 342 万（本地）/ 446 万（生产）                  | 大表；Q3 归本域则按 sid 分片回填 |
| `v2_send_order_label` | 本地无（生产有）                                | 软删表                           |
| `dg_airbill`          | 10 万（本地）                                   | 归 logistics，不随本域迁         |

---

## 四、关键建模决策（逐条给理由）

### 4.1 sid 主键对齐 + sn 超长字段处置

- `send_orders.id == dg_sendorder.sid`（显式带 id + PREPARE 顶自增；sid 有空洞——本地 AUTO_INCREMENT 672,867 / 实 ~1.9 万）
- `sn` varchar(2550) → `sn String @db.VarChar(64)`：本地实测 sn 实际长度（回填断言 `CHAR_LENGTH(sn) <= 64`，超长的入 `snExtra` JSON 兜底并告警）——2550 是历史无约束残留，新系统收紧
- `countweight` varchar(1500) → `chargeableWeightGrams Int?`：类型错误修正（计费重是数值；无法解析的入 `legacyExtra`）

### 4.2 关系只存一侧：`oids` 双写废除

- 新系统**只存 `orders.sendOrderId`**（order 域已定）；`send_orders` **无 oids 列**
- 运单侧反查订单：`orders WHERE send_order_id = ?`；取消运单 = 清 `sendOrderId` + 状态回 4（order 域 cas）
- 同捆：`SendOrder.bundledIntoId Int?`（parent_id 迁移）+ `bundledSendOrders SendOrder[]` 关系；**禁逗号串**
- ⚠ 回填：`orders.sendOrderId` 直接从 `dg_order.sid` 取（'0'/''→NULL，仅纯数字 CAST）；`dg_sendorder.oids` 仅作 T1→T2 反向同步校验，**不作回填源**

### 4.3 totalfee 禁信历史值：服务端重算 + 单一口径

- 新系统 `send_orders` **不存 totalfee 快照列**（或只存 `chargedTotalFee` 审计列，禁作业务读值）——所有业务读值走服务端 `calculateTotalFee()`（公式内嵌在计费服务，费率配置化归 finance 域，Q7 order 域同款）
- 公式：`freight + serverfee + customsfee + remotefee + domesticShippingFee`（domestic 兜底规则原样保留：运单 sendprice>0 用之，否则 Σ 订单 sendprice>0 排除无效态排除转运）
- `Insurancefee` 独立列（**禁并入 totalfee**——FinanceStatistic 单独相加的口径保留为对账规则）
- 扣费/返金一律 finance 事件（`ledger_entries`），send-order 只落 `chargedAt` 与金额快照
- 发票场景的例外口径（sendprice 取发票子项汇总）作为**显式方法参数**保留，禁隐式分叉

### 4.4 状态机 cas + 显式迁移表 + 状态历史

- `status` Int + contract zod enum；cas 更新；迁移表白名单（§3.2 已核实部分：取消仅 1、支付 7→8、收货→3、出库/评价要求 3）
- `send_order_status_histories`（sid, fromStatus, toStatus, operatorType, operatorId, reason, createdAt）——同时承载 **prostate 作业流变迁**（`kind: state|prostate` 区分两流，禁混枚举）
- 5/6 态写入点未定位全的部分（Q4）：迁移表对未核实迁移一律拒

### 4.5 prostate 作业流独立建模

- 与 state 并存但不是同一概念：state 是**客户可见的运单生命周期**，prostate 是**仓库作业子状态**（等同捆等待/FBA 作业/找货/做发票/拍照/缝标）
- 新系统：`prostate Int?` + `prostateEnteredAt` + `prostateHistories`（并入状态历史表，`kind='prostate'`）
- 作业流与 WMS 边界：prostate 9 等客户指示/打包中等动作触发者是仓库——WMS 独立项目通过 `wms-gateway` 回写

### 4.6 fapiao 归属拍板建议：归 send-order（Q3 收口）

- `dg_fapiao` 446 万行，`fid` PK，`sid`+`oid`+`uid` 三维关联，55 列（货物/收件人/材质/汇率/包装全量快照）
- **建议归 send-order 域**：发票是运单维度的出货文件（sid 维度 + `fapiaotime` + `havefapiao` + `invoice_completed_type` 全在运单上）；order 域只在下单/改单时提供金额快照
- 新表 `invoices`：`id == fid`、`sendOrderId`（sid）、`orderId`（oid，可空——主运单发票无单 oid）、金额族 Decimal 化（`exchangerate` 汇率快照保留）、`goodsCaizhi` 等快照列原样
- `v2_send_order_invoice_event` → `send_order_invoice_events`（append-only，`invoiceVersion` 版本号是开放接口锁内校验的关键）

### 4.7 label 建模（四类型三状态）

- `send_order_labels`：`id`、`sendOrderId`、`memberId`、`type`（contract 枚举 fba_box/fba_item/3pl_box/carrier）、`status`（0/1/2）、文件族（filePath/fileName/mime/size）、`fbaShipmentId`、`destinationCode`、`boxes Json`、`scanResult Json`、`photoUrls Json`、`appliedAt`/`verifiedAt`、软删
- 文件走对象存储（OSS），库内只存 path——**禁存 base64**

### 4.8 importer_info 结构化 + 掩码防护前置

- `importer_info` varchar(2048) JSON → `importerInfo Json?`（保留 JSON，键契约化：aid/real_time_account/...）
- **保存服务层强制**：`real_time_account` 检出掩码 → 按 aid 地址簿或原值补回 → 对不上拒绝（旧 #51 逻辑照搬）；契约层同步校验

### 4.9 mailremark 双形态拆分 + mark_flag 拆包

- `mailremark` → `mailRemark String?`（文本）+ `mailAttachments Json?`（路径数组）两列，禁双形态
- `mark_flag` int 位运算 → 显式列（位定义待反查，Q5；参照 order 域 2bit 一态经验先做占位）

### 4.10 索引：照搬旧表「真正被用到的」

- `send_orders`：`(memberId, createdAt)`、`(status)`、`(sn)`（旧 idx 有 MUL）、`(bundledIntoId)`、`(otype, status)`（Dingtalk 统计路径）
- `send_order_labels`：`(sendOrderId, type)`、`(status)`
- `send_order_invoice_events`：`(sendOrderId, createdAt)`、`(ticketId)`
- `invoices`：`(sendOrderId)`、`(orderId)`、`(memberId, fapiaotime)`
- ⚠ 旧表 20+ 索引多数为 admin 统计服务，新系统按实际查询面重建

---

## 五、Prisma schema 草案（核心模型字段级）

> 完整 schema 待本节评审后落入 `packages/db/prisma/schema.prisma`（send-order 段）。命名纪律同 order 域：snake_case `@map`、金额 Decimal、禁外键、枚举 Int/String + `///`。

```prisma
/// 配送委托运单（sid 维度）。旧源 dg_sendorder
model SendOrder {
  id Int @id @default(autoincrement()) // == 旧 dg_sendorder.sid（回填对齐）
  /// 同捆主运单（旧 parent_id；NULL = 主运单/独立单）
  bundledIntoId Int? @map("bundled_into_id")
  /// 运单流水号（旧 sn；本地断言 ≤64，超长入 snExtra）
  sn String? @db.VarChar(64)
  snExtra Json? @map("sn_extra")
  memberId Int @map("member_id")
  /// 运单类型：1 普通代购 / 3 一件代发（旧 otype，只有 1/3）
  orderType Int @default(1) @map("order_type") @db.TinyInt
  /// 8 态状态机（contract SendOrderStatus，§3.2）；cas 更新
  status Int @default(1) @db.SmallInt
  statusEnteredAt DateTime @default(now()) @map("status_entered_at")
  /// 作业子状态 0-9（contract ProstateCode，§3.2）——与 status 并存的两条流
  prostate Int? @db.TinyInt
  prostateEnteredAt DateTime? @map("prostate_entered_at")

  // ---- 金额（§4.3 双币种分组；totalfee 禁存历史值，服务端重算）----
  /// 对客国际运费 CNY（旧 freight）
  internationalFreight Decimal @default(0.00) @map("international_freight") @db.Decimal(14, 2)
  /// 采购国际运费 CNY（旧 ufreight，成本）
  purchaseInternationalFreight Decimal @default(0.00) @map("purchase_international_freight") @db.Decimal(14, 2)
  /// 增值费 CNY（旧 serverfee）
  serviceFee Decimal @default(0.00) @map("service_fee") @db.Decimal(14, 2)
  /// 报关费 CNY（旧 customsfee）
  customsFee Decimal @default(0.00) @map("customs_fee") @db.Decimal(14, 2)
  /// 偏远费 CNY（旧 remotefee）
  remoteFee Decimal @default(0.00) @map("remote_fee") @db.Decimal(14, 2)
  /// 国内运费 CNY（旧 sendprice；0 = 走订单兜底，禁直接读）
  domesticShippingFee Decimal @default(0.00) @map("domestic_shipping_fee") @db.Decimal(14, 2)
  /// 保险费 CNY（旧 Insurancefee——禁并入 totalfee，对账单独口径）
  insuranceFee Decimal @default(0.00) @map("insurance_fee") @db.Decimal(14, 2)
  /// 实扣总费快照（已邮寄/支付成功时回写；审计用，禁作业务读值）
  chargedTotalFee Decimal? @map("charged_total_fee") @db.Decimal(14, 2)
  /// 运单砍价汇总（旧 bargainprice = Σ order.bargainprice 排除无效态）
  bargainAmount Decimal @default(0.00) @map("bargain_amount") @db.Decimal(14, 2)
  /// 砍价返金状态（旧 bargainstate：0 未返 / 1 已返）+ 返金时间
  bargainRefunded Boolean @default(false) @map("bargain_refunded")
  bargainRefundedAt DateTime? @map("bargain_refunded_at")
  /// 优惠券快照（旧 couponid/couponmoney；券实体归营销域）
  couponId Int? @map("coupon_id")
  couponAmount Decimal? @map("coupon_amount") @db.Decimal(14, 2)
  /// 损坏/修理费（旧 xiwgfei，语义待查 Q1）
  damageFee Decimal? @map("damage_fee") @db.Decimal(14, 2)
  /// 已收取费（旧 yishouqufee）
  receivedFee Decimal? @map("received_fee") @db.Decimal(14, 2)
  /// 仓储费 CNY（旧 storage）
  storageFee Decimal? @map("storage_fee") @db.Decimal(14, 2)
  /// 计费金额（旧 countmoney）
  chargeableAmount Decimal? @map("chargeable_amount") @db.Decimal(14, 2)
  /// 计费重 g（旧 countweight varchar → Int；不可解析入 legacyExtra，Q2）
  chargeableWeightGrams Int? @map("chargeable_weight_grams")

  // ---- 收件人快照（历史事实，保留）----
  consignee String @db.VarChar(30)
  enName String? @map("en_name") @db.VarChar(30)
  country String? @db.VarChar(30)
  city String? @db.VarChar(30)
  zip String? @db.VarChar(30)
  tel String? @db.VarChar(30)
  address String? @db.VarChar(255)
  /// 进口商信息 JSON（旧 importer_info；real_time_account 禁掩码，§4.8）
  importerInfo Json? @map("importer_info")
  companyName String? @map("company_name") @db.VarChar(100)

  // ---- 物流/配送 ----
  /// 配送渠道（旧 did/deliveryname；词表 contract：直送小包/ZC航空便/ヤマト急便/中国郵政船便/OCS）
  deliveryChannel String? @map("delivery_channel") @db.VarChar(30)
  /// 发货仓（旧 shipping_warehouse）
  shippingWarehouse String? @map("shipping_warehouse") @db.VarChar(20)
  /// 通关类型（旧 passtype，词表待查 Q3）
  passType Int? @map("pass_type") @db.TinyInt
  /// 可否发货（旧 dfsendflag）
  canShip Boolean @default(false) @map("can_ship")
  /// 代发收货码（旧 dfshcode；已邮寄清空）
  dfReceiveCode String? @map("df_receive_code") @db.VarChar(30)
  /// 代发收件族（旧 dflwh/dfsendtel/dfsendaddress/dfsendname/dfsendinfo）
  dfTrackingNo String? @map("df_tracking_no") @db.VarChar(30)
  dfConsignee String? @map("df_consignee") @db.VarChar(50)
  dfTel String? @map("df_tel") @db.VarChar(50)
  dfAddress String? @map("df_address") @db.VarChar(255)
  dfRemarkCn String? @map("df_remark_cn") @db.VarChar(512)

  // ---- 发票/标签/作业 ----
  /// 发票是否给用户（旧 havefapiao）
  invoiceDelivered Boolean @default(false) @map("invoice_delivered")
  invoiceDeliveredAt DateTime? @map("invoice_delivered_at")
  /// 发票完成方式：1 系统生成 / 2 人工生成（旧 invoice_completed_type）
  invoiceCompletedType Int @default(1) @map("invoice_completed_type") @db.TinyInt
  invoiceCompletedAt DateTime? @map("invoice_completed_at")
  /// 包裹数（旧 totalpackages）
  totalPackages Int? @default(0) @map("total_packages")
  /// 贴标规则 0-3（旧 madeinchina_flag）
  madeInChinaFlag Int? @default(0) @map("made_in_china_flag") @db.TinyInt
  /// 原包装：0 废弃 / 1 保留（旧 origin_package_choice）
  originPackageKeep Boolean @default(false) @map("origin_package_keep")
  /// 邮件备注文本（旧 mailremark 双形态拆分，§4.9）
  mailRemark String? @map("mail_remark") @db.VarChar(1024)
  /// 邮件附件路径数组（旧 mailremark.files）
  mailAttachments Json? @map("mail_attachments")
  /// 评价 JSON（旧 comment/reply/showcomment/commenttime）
  comment Json?
  /// 位运算标记（旧 mark_flag；位定义待反查 Q5）
  markFlags Int? @map("mark_flags")
  /// 历史兜底（旧 sn 超长部分 / countweight 脏值 / xiwgfei 语义查明前的原值）
  legacyExtra Json? @map("legacy_extra")

  createdAt DateTime? @map("created_at") @db.DateTime(0) // 旧 addtime
  updatedAt DateTime? @map("updated_at") @db.DateTime(0) // 旧 uptime
  deletedAt DateTime? @map("deleted_at") @db.DateTime(0)

  bundledInto SendOrder? @relation("Bundle", fields: [bundledIntoId], references: [id])
  bundledSendOrders SendOrder[] @relation("Bundle")
  labels SendOrderLabel[]
  invoiceEvents SendOrderInvoiceEvent[]
  valueAddedServices SendOrderValueAddedService[]
  invoices Invoice[]
  statusHistories SendOrderStatusHistory[]

  @@index([memberId, createdAt])
  @@index([status])
  @@index([sn])
  @@index([bundledIntoId])
  @@index([orderType, status])
  @@map("send_orders")
}
```

其馀模型关键字段表（评审后同批落 schema）：

| 模型                         | 关键字段（新名 ← 旧名）                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 唯一键 / 索引                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `SendOrderStatusHistory`     | sendOrderId；`kind`（state/prostate 两流）；fromStatus/toStatus（Int?）；operatorType/operatorId；reason；createdAt                                                                                                                                                                                                                                                                                                                                                         | INDEX (sendOrderId, createdAt)                         |
| `SendOrderLabel`             | sendOrderId；memberId；`type`（fba_box/fba_item/3pl_box/carrier）；`status`（0/1/2）；filePath/fileName/mime/size；fbaShipmentId；destinationCode；boxes Json；scanResult Json；photoUrls Json；appliedAt/verifiedAt；deletedAt                                                                                                                                                                                                                                             | INDEX (sendOrderId, type)、(status)                    |
| `SendOrderInvoiceEvent`      | sendOrderId；memberId；`type`（revise_requested/paid_confirmed）；`invoiceVersion`；comment；imageUrls；source；ticketId；createdAt（append-only）                                                                                                                                                                                                                                                                                                                          | INDEX (sendOrderId, createdAt)、(ticketId)             |
| `SendOrderValueAddedService` | sendOrderId；serviceId；nameSnapshot；fee；isManual                                                                                                                                                                                                                                                                                                                                                                                                                         | INDEX sendOrderId                                      |
| `Invoice`                    | `id == fid`；sendOrderId；orderId（可空）；memberId；货物族（goodsName/goodsPrice/goodsNum/goodsUrl/goodsId/goodsCaizhi）；收件人族；`transport`/`airbill`/`totalweight`/`country`/`teams`/`packages`；`tariff`/`goodsinternational`/`amount`；`goodsTotal`/`subtotal`；`exportName`/`exchangerate`/`salesName`/`salesTel`/`rateType`；`boxnum`/`sendprice`/`goodsImg`/`hyboxnum`/`expcnname`/`packageName`/`packageId`/`bargainprice`/`enName`/`goodsUseful`/`gUsefulMemo` | INDEX (sendOrderId)、(orderId)、(memberId, fapiaotime) |

---

## 六、过渡期共存策略（沿用 Q7：新表正本 + 同库事务双写）

1. **双写范围**：新系统写 `send_orders`/`send_order_labels`/`send_order_invoice_events`/`invoices` + 旧 `dg_sendorder`/`dg_fapiao`/`v2_send_order_label` 在同一 MySQL 同一事务 upsert。读只读新表。
2. **主键对齐**：`send_orders.id == dg_sendorder.sid`；`invoices.id == dg_fapiao.fid`。
3. **金额重算**：totalfee 五费公式在双写服务内现算（与旧系统改造后口径一致）；`Insurancefee` 独立列禁混。
4. **oids 退出**：双写期旧系统仍读 `dg_sendorder.oids`——新系统写 `orders.sendOrderId` 后，由双写服务**反向投影**生成旧 oids 串（旧系统视角兼容），T2 后停止投影。
5. **返金幂等**：bargainstate + Record action=11 双保险照搬；新系统以 `bargainRefunded` + ledger 事件号双判重。
6. **切换时序**：T0 建新表 → T1 回填+读新写双 → T2 切写入口 → T3 旧表降级只读投影。
7. **热表分批**：`dg_fapiao` 446 万行按 fid 分片 + 短连接（生产跳板机隧道长连接不稳教训）。

---

## 七、与 contract 的边界

- `packages/contract/src/domains/send-order.ts` 是唯一对外类型源；词表：`SendOrderStatus`（8 态）、`ProstateCode`（0-9）、`SendOrderType`（1/3）、`LabelType`（4 种）、`LabelStatus`（3 态）、`InvoiceEventType`（2 种）、`DeliveryChannel`（5 种）、`MadeInChinaFlag`（0-3）
- 开放 API 入参全覆盖校验：支付验证码一次性、取消仅 status=1、`sid` 归属校验（tokenable 名下）
- `importer_info.real_time_account` 契约层禁掩码（与服务端补回逻辑双保险）
- Prisma 类型禁入路由出参（docs/07 c2）

---

## 八、未决问题（需业务/用户确认）

> **2026-10-15 更新**：Q1/Q2/Q3/Q5/Q6/Q7/Q10 已全部收口，依据见 `06-send-order-评审与拍板.md`（本地 taotaro 副本实测）；Q4/Q8/Q9 留待后续。

| #   | 问题                                                                                                                                                                                        | 影响                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Q1  | ~~`xiwgfei` 语义？~~ **已收口**：本地全 0，保留 nullable `damageFee` 审计兜底，禁入公式                                                                                                     | 保留列                                                    |
| Q2  | ~~`countweight` 实际存什么？~~ **已收口**：十进制千克字符串 → `chargeableWeightGrams`（×1000，不可解析入 legacyExtra）；注意 `dg_fapiao.totalweight` 是另一套口径（含代码值 `A`）→ 字符串列 | 解析规则已定                                              |
| Q3  | ~~`dg_fapiao` 归 send-order 还是 order？~~ **已拍板归 send-order**（`06-send-order-评审与拍板.md` §一：sid 是关联枢纽、发票生命周期字段全在运单、order 域无发票字段）                       | 域边界定                                                  |
| Q4  | state 5（处理中）/6（待审核）的写入点未定位全                                                                                                                                               | 新系统迁移表对未核实迁移一律拒（§4.4）；生产灰度前补核实  |
| Q5  | ~~`mark_flag` 位定义？~~ **已收口**：本地全 NULL 且无位读写点 → `markFlags Int?` 原样列不拆包                                                                                               | 显式列取消                                                |
| Q6  | ~~`passtype`/`did`/`deliveryname` 关系？~~ **已收口**：`deliveryChannel` 存 deliveryname 自由字符串（14 观察值，contract 容错新值）；`did` 不建模；`passType Int?` 可空                     | 契约化方案已定                                            |
| Q7  | ~~同捆金额语义？~~ **已收口**：51 子运单全部独立计费（totalfee 全 >0），`bundledIntoId` 纯组织关系禁 rollup                                                                                 | 金额语义已定                                              |
| Q8  | `v2_send_order_label` / `v2_send_order_invoice_event` 本地无表                                                                                                                              | 回填脚本 PREPARE 条件执行本地跳过；生产跑前跳板机只读确认 |
| Q9  | 评价（comment JSON） schema 键位                                                                                                                                                            | contract 切片时定；`comment Json` 先原样落库              |
| Q10 | ~~`sn` 生产实际最大长度？~~ **已收口**：本地最长 363（`#` 连接多单号）→ `sn VarChar(64)` 首段 + 全量拆分为 `snExtra Json`，断言 ≤64 全表成立                                                | 收紧方案已定                                              |

---

## 九、下一步

1. ~~评审 §四决策（重点 Q3 发票归属与 Q7 同捆金额语义）~~ → **已拍板**（`06-send-order-评审与拍板.md`，本地 taotaro 副本实测）
2. ~~落 `packages/db/prisma/schema.prisma` send-order 段（6 模型）~~ → **已落地**（49 模型总量，`prisma validate` 通过）；增量 diff 生成 `0003-send-order-domain-up.sql`（禁手改）
3. ~~T1 回填（sid 对齐 + fapiao + oids 单侧关联校正），本地 `crossbuy_dryrun` 演练~~ → **已落地并演练通过**（`0010~0013`：send_orders 3,437 / invoices 29,238 / vas 36 / 五费总额 3,066,980.18 分毫不差 / 18 断言 PASS / 两遍幂等）
4. send-order 域 contract 定义（`packages/contract/src/domains/send-order.ts`）——与 order 域 contract 同批
5. 支付验证码 / 取消 / 返金幂等的 worker 化设计（ BullMQ job，含 webhook 重放防护）
6. Q4（state 5/6 写入点）/Q8（label/event 生产行数）/Q9（comment JSON 键位）随 contract 与灰度前补核实
