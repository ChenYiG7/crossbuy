# order 域 schema 设计（精读旧系统后）

> 依据：`docs/plans/00-旧库表结构盘点.md`、`docs/plans/01-v2表字段精读.md`、`docs/00-原项目参考指南.md`、`docs/07-开发规范守则.md`
> 旧系统精读源（只读）：`haiou/taotaro.sql`（表结构 dump）、`haiou/backend/app/Models/Order.php`（2609 行）、`app/Services/OrderAmountSyncService.php`、`backend/docs/business/` 下 order 相关 12 篇
> 状态：**草案**。对应 TODO **#10**（order + send-order：先补知识再动刀）——本文即「补知识」产物；send-order 域另出 `send-order-schema.md`。
> 共存策略沿用 member 域已定决策（Q7：新表正本 + 同库事务双写），见 `docs/plans/member-迁移与共存.md`。

---

## 一、域边界

### 1.1 order 域负责

- **订单主链路**：采购单分组（tid）、订单行（oid）、订单扩展信息、下单防重映射、平台自动下单记录
- **平台电商链路**：平台店铺、平台订单/子单、平台商品/SKU、平台金额快照、平台 SKU↔订单关联
- **下单入口**：购物车（加购→下单）、Excel/API 导入批、询价单（询价→报价→建单）
- **订单附属**：订单站内信、检品记录、禁运（无效）标记、库存拆分记录
- **开放 API 的订单侧**（`/api/v1/orders` 创建/取消/查询，契约归 member 域 webhook 但业务在 order）

### 1.2 order 域不负责（跨域，禁直接建库关联）

| 域 | 表 | 边界说明 |
|---|---|---|
| member | `dg_users` / `dg_address` | Order 只存 `memberId`，禁冗余 uname/memberid（见 §4.10） |
| send-order | `dg_sendorder` + `v2_send_order_*` | 运单是**另一个聚合根**；Order 只存 `sendOrderId`（单向） |
| finance | `dg_record` / `finance_order_cash_flow` / `dg_rechargerecord` | 余额正本在 `ledger_entry`；order 域的每一次扣费/返金都是 finance 事件 |
| WMS | `dg_stores` / `dg_shelf*` / `dg_order_split` 的库存扣减 | 库存 = `dg_order.goodsnum` 是旧系统硬伤；新系统库存台账归 WMS，order 只留 `dfStoreMode` 标记与拆分记录 |
| logistics | `v2_logistic_domestic` | 到库物流记录；Order 经关系表关联（多对多） |
| ticket | `v2_ticket` | 售后工单；经 `ticketable` 多态关联 Order（契约层禁暴露 `*_type`） |

> 边界判定依据：`AGENTS.md`（Order · SendOrder · Finance · Logistics · Member/User · WMS · Ticket · Email）。
> `v2_ecommerce_shop` 归属已在 member-schema.md 拍定：**Shop 归 order 域**（member 域只持有会员）。

### 1.3 一条订单的跨域生命周期（总览）

```
购物车 dg_cart ──┐
导入批 dg_imporder ──┼──► dg_order（oid，商品行级）── 扣费 payOrder ──► dg_record（finance）
询价单 dg_inquiry_order ──┘        │
                                   ├── 平台采购：v2_order_auto_created + v2_platform_order_amount（tid 维度金额快照）
                                   ├── 到库：v2_logistic_domestic（logistics）+ dg_stores（WMS 保管单）
                                   ├── 售后：dg_examination_record（检品）+ v2_ticket（工单）
                                   └── 出库：dg_sendorder（send-order，sid 绑定）+ dg_fapiao（发票，建议归 send-order）
平台订单 v2_ecommerce_order ──confirm──► dg_order（一件代发自动建单，余额预检）
```

---

## 二、实体清单与源表映射

| # | 新实体（Prisma model） | 目标表名 | 源表 | 旧表量级 | 备注 |
|---|---|---|---|---|---|
| 1 | `OrderGroup` | `order_groups` | `dg_order.tid` 分组（**旧系统隐式存在，无表**） | ~tid 数 | ★ 新增聚合根：整单砍价/运费挂组，消灭 carrier 机制（§4.1） |
| 2 | `Order` | `orders` | `dg_order` | **587 万行** | 商品行级订单（oid），域根实体 |
| 3 | `OrderExtension` | `order_extensions` | `v2_order_detail` | 与 oid 1:1 | 翻译/coupon/seller_change_amount |
| 4 | `OrderClientRef` | `order_client_refs` | `v2_order_client_ref` | — | 下单幂等第二道防线 |
| 5 | `OrderPlatformCreation` | `order_platform_creations` | `v2_order_auto_created` | **316 万行** | 1688/淘宝全球购自动下单记录 |
| 6 | `PlatformTradeAmount` | `platform_trade_amounts` | `v2_platform_order_amount` | 2,273 | ★ 金额演进快照（first/latest），对账锚点 |
| 7 | `PlatformOrder` | `platform_orders` | `v2_ecommerce_order` | 1,366 | 平台订单（同步进来的原始单） |
| 8 | `PlatformOrderItem` | `platform_order_items` | `v2_ecommerce_order_item` | 1,332 | 平台子单↔平台 SKU |
| 9 | `Shop` | `shops` | `v2_ecommerce_shop` | 9 | 平台店铺（member-schema.md 已定归 order） |
| 10 | `PlatformProduct` | `platform_products` | `v2_ecommerce_product` | 14,854 | 平台商品目录 |
| 11 | `PlatformProductSku` | `platform_product_skus` | `v2_ecommerce_product_sku` | 208,208 | 平台 SKU 目录 |
| 12 | `PlatformSkuOrderLink` | `platform_sku_order_links` | `v2_relation_ecommerce_product_sku_and_order` | 87 | SKU↔订单（电商库存统计入口） |
| 13 | `OrderSplit` | `order_splits` | `dg_order_split` | 32K | 无库存拆分记录（原单↔拆分单） |
| 14 | `InquiryOrder` | `inquiry_orders` | `dg_inquiry_order` | 24 | 询价单 |
| 15 | `InquiryOrderItem` | `inquiry_order_items` | `dg_inquiry_order_item` | 150 | 询价子单（报价行） |
| 16 | `ImportBatch` | `import_batches` | `dg_imporder` | 92K | Excel/API 导入批 |
| 17 | `ImportItem` | `import_items` | `dg_imporder_detail` | 266K | 导入明细（→ 订单） |
| 18 | `OrderInvalidMark` | `order_invalid_marks` | `dg_invalid_order` | 171K | 禁运/无效标记（按商品 item_id） |
| 19 | `OrderMessage` | `order_messages` | `dg_yunjiao` | **293 万行** | 订单站内信（含星标） |
| 20 | `ExaminationRecord` | `examination_records` | `dg_examination_record` | 468K | 检品记录 |
| 21 | `OrderExamination` | `order_examinations` | `relation_order_and_examination_record` | 502K | 订单↔检品记录（多对多，显式列） |
| 22 | `Cart` | `carts` | `dg_cart` | **697 万行** | 购物车（下单入口，含检品勾选快照） |

**明确不建模 / 归他域**：

| 旧表 | 处置 |
|---|---|
| `dg_fapiao`（发票，446 万行） | 建议归 **send-order 域**（sid 维度）；order 域只在下单/改单时提供金额快照（Q3 待确认） |
| `dg_stores` / `dg_shelf*` | 归 **WMS**（独立项目）；`oids/outoids` 逗号分隔字符串改关系表 |
| `dg_record` / `finance_order_cash_flow` / `dg_rechargerecord` | 归 **finance**（`ledger_entry` + 对账批次） |
| `relation_order_and_finance_order_cash_flow`（261 万行） | 归 finance：ledger_entry 直接带 `orderId`，禁多对多中间表 |
| `relation_order_and_operation_record`（2216 万行） | 归 admin 域操作日志；新系统日志表带 `orderId` 索引即可 |
| `deprecated_dg_order_copy` 等 | ❌ 排除 |
| `dg_otype` / `dg_payid` / `dg_pm` / `dg_favorite` | 字典/站内信旧代际，不随 order 域迁移（`dg_otype` 分类归属见 Q4） |

---

## 三、旧系统 order 域全景精读（建模前必读）

### 3.1 `dg_order` 字段分组精读（oid 主键，587 万行）

**身份/归属**
- `oid` INT PK AUTO_INCREMENT=5,872,062；`uid` INT；`uname`/`memberid`（**冗余副本**，无 JOIN 习惯）；`xz`（拍货分派选中值）；`belong_company`（HHO/Gouba 双公司）
- `type` smallint DEFAULT 0 —— **1 代购 / 2 转运 / 3 一件代发**（`ORDER_TYPE_*`，另有 `$orderFlags DG=1/ZS=2/DF=3` 两套编码并存）
- `add_from` tinyint —— 0 老网站 / 1 新网站 / 2 下单插件 / 3 订单列表重新下单 / **8 = API 下单**（开放接口写死）；`add_from_memo` 备注
- `purchase_type` —— 0 一键下单 / 1 手动采购 / 2 自动下单（**与 add_from 语义重叠**，见 §4.7 合并）
- `outid` varchar(80) 客人外部管理号（有索引，对接方重要）

**商品快照（旧系统把商品信息全量冗余在订单行）**
- `goodsid` varchar(20)、`goodsurl` varchar(512)、`goodsname`、`goodsimg`、`goodssize`/`goodscolor`、`goodsseller`、`sellerurl`、`goodssite`/`siteurl`
- `sku_name` varchar(1024) 颜色尺码；`goodsseller`；`supplier_shop_id`/`supplier_product_id`（**仅 ID，无外键**，指向 supplier 域）
- `typeid` smallint DEFAULT 12 —— 商品分类（`dg_otype` 字典，归属待定 Q4）
- `goodsremark`~`goodsremark4` 4 个备注列 + `mremark`（管理备注）+ `orderremark` + `buyer_memo`/`buyer_remark_icon`（买家备忘）

**金额（★ 全 float(10,2)，红线区）**
- `goodsprice` float —— 商品原价（对客单价）
- `goodsprice1` **decimal(10,2)** —— 砍后单价（发票优先用此列）
- `goodsuprice` float —— **商品采购价**（CNY，成本）
- `sendprice` float —— 订单运费（对客）；`senduprice` float —— 采购国内运费（CNY，成本）
- `bargainprice` float NOT NULL —— **整单砍价总额**（holder 机制承载列，语义极特殊，见 §3.5）
- `proprice` float 促销价；`inspection` float 验货金额；`orderweight` int 重量

**分组/关联键**
- `tid` varchar(50) —— **平台交易号（1688 一次店铺下单）**，同 tid 多 oid = 一次采购；有 `idx_tid`
- `sid` varchar(50) —— 运单号（`dg_sendorder.sid`；解绑时置 0）。⚠ **关系双写**：`dg_sendorder.oids` 也存订单号列表（mediumtext 逗号分隔）
- `payid` varchar(50)（idx_payid_and_addtime；业务语义待查 Q1，代码仅 fillable）
- `pinoid`/`pinnum` —— 拼单遗留字段（仅 admin form 展示，无业务逻辑，Q2）
- `bufaid` varchar(255) —— 补发单号；`expressno` varchar(100) —— 国内物流号（**隐式关联键**，到库/货架/仓储/打印全靠它）

**状态与流程时间戳（10 个 INT unix 列）**
- `state` smallint DEFAULT 1（12 态状态机，见 §3.2）
- `addtime`/`uptime`/`paytime`（**注释「采购下单时间（非付款时间）」——命名坑**）/`conttime`（已确认）/`waytime`（在途）/`incretime`（增值中）/`custowaittime`（售后待确认）/`custotime`（售后中）/`rukutime`（入库）/`peisongtime`（提交配送）/`wuxiaotime`（无效）/`print_examination_time`（打印全检单）/`arrivetime`（到货）
- **每个状态一个时间戳列**（共 10+ 个）：新系统用 `state_entered_at` + 状态历史表替代（§4.4）

**条款/标记**
- `TermQty`/`TermPrice`/`TermShipping` varchar(10) DEFAULT 'Y' —— 数量不足按库存购买 / 价格多退少补 / 国内运费多退少补（**字符串当布尔**）
- `flag` smallint DEFAULT 1 —— 敏感货（2 是 / 1 不是）；`ship` tinyint —— 1 空运 / 2 海运 / 3 敏感货
- `isjinji` varchar(225) —— 紧急订单标记（**varchar 当布尔**）
- `mark_flag` int —— 客户自定义标记**按位运算**（`MARK_FLAG_FAVORITE` 等，§4.11）
- `dfstoremode` tinyint —— 0 一件代发直发 / 1 一件代发**库存**（库存数量 = 本单 goodsnum，无库存流水）
- `agobgflag`/`agobginfo` —— 历史砍价记录；`item_location` 货物位置；`extend` text —— 扩展 JSON（`deducted_service_fee` 服务费抵扣、inquiry 来源等）；`auto_order_error` 自动下单失败原因；`deleted_at` 软删

**检品/增值勾选家族（30+ 列，最大硬伤）**
- `var1`~`var6`、`var8`~`var12` —— 检品勾选（**只有 `1`/`"1"` 算勾选，写入 `"1"`；`"0"`/0/false/空写空字符串**；var7 是自由文本）
- `yanhuofba`/`yanhuojinyun`/`yanhuozengzhi`/`yanhuoasin`/`yanhuofnsku` —— 验货家族（FBA/谨运/增值/ASIN/FNSKU）
- `SKU`/`shangpin_sku`/`FNSKU`/`shangpin_fnsku`/`name`/`shangpin_name`/`amazon`/`putong`/`shangpin_amazon` —— 平台标签订阅（**列名即谜因**，如 `putong`=普通、`tiebiao`=贴标、`huanbaoz`=环保、`fuzhuang`=服装、`qita`=其他）
- `baozhuang`/`hbbaozhuang`/`baonum` —— 包装/换包装/包数

### 3.2 状态机：`state` 12 态（Order.php 定稿）

| 值 | 常量 | 中文 | 日文 | 备注 |
|---|---|---|---|---|
| 1 | `STATE_WAIT_CREATE` | 采购中 | 買い付け中 | **唯一可取消态之一**（与 6） |
| 2 | `STATE_PAID` | 已采购 | 買い付け完了 | |
| 3 | `STATE_SEND` | 从商店发货完成（在途） | ショップから出荷済み | 库存拆分允许的源态 |
| 4 | `STATE_ARRIVE_CHINA` | 到达本公司仓库 | 義烏倉庫到着 | **提交运单的唯一入口态** |
| 5 | `STATE_DELIVERY` | 发送请求提交完毕 | 配送依頼提出済み | 取消运单回 4 |
| 6 | `STATE_INVALID` | 无效订单（未返金） | 無効オーダー（返金待ち） | **可取消态**；无效态不参与金额计算 |
| 7 | `STATE_CHECKING` | 增值检品中 | オプション検品中 | 库存拆分允许的源态 |
| 8 | `STATE_403_AIRLINE` | 航空禁运品 | 禁輸品 | |
| 9 | `STATE_EXAM_FAILED` | 不良对应（售后）中 | 不良対応中 | 进入即给 expressno 加 `_S` 后缀 |
| 10 | `STATE_INVALID_REFUND` | 无效订单（已返金） | 無効オーダー（払い戻し済み） | **最终态** |
| 11 | `STATE_INVALID_DISUSE` | 无效订单（已废弃） | 無効オーダー（廃棄完了） | **最终态** |
| 12 | `STATE_EXAM_FAILED_WAIT_FOR_CHECK` | 不良对应（售后）待确认 | 不良対応中（售后审核中） | 同 9 加 `_S` |

- `$invalidStates = [6, 10, 11]`：**金额计算一律排除**（`isAmountCalculationExcludedState` / `applyExcludingInvalid`）
- `$finalStates = [10, 11]`：终态
- **已核实的迁移**（来自代码/文档）：提交运单只允许 4；取消运单 5→4；取消订单只允许 1/6；库存拆分源态限 3/4/7 且 `dfstoremode=1`；检品打标可到 4/7/9/12；售后 9/12 → 仅在途(3) 时去 `_S`
- ⚠ 旧系统**没有迁移表**，状态合法性散落在各 Controller/Form（`BatchUpdateOrder`/`BatchUpdateOrderForCheck`/`BatchUpdateOrderState`）——新系统必须集中定义（§4.4）

### 3.3 金额体系（重写的核心原料）

**(a) 下单扣费 `Order::payOrder()`**（`dg_record.action=1`，`ordflag` 1 代购/3 代发）

| 订单类型 | 用户条件 | 扣费公式 |
|---|---|---|
| 代购 DG | 月额会员（`validity>=today && utype=1`） | `goodsprice × goodsnum` |
| 代购 DG | 普通 | `goodsTotal + ceil(goodsTotal×0.05×100)/100 − extend.deducted_service_fee`（**5% 服务费硬编码在模型层**） |
| 代发 DF | 月额会员 | `goodsprice × goodsnum` |
| 代发 DF | 高额商品（`ISAMTLIMIT=1 && goodsprice>AMTLIMIT=200`） | `goodsprice × goodsnum × 1.05` |
| 代发 DF | 普通 | `(goodsprice + dffee) × goodsnum`（`dffee` = 会员件数手续费，默认 10） |

**(b) 改单即时结算 `Order::modifyGoodsprice()`**（后台改价/改量，先返/扣余额再联动）

| 订单类型 | 用户条件 | 改 goodsprice 乘数 | 改 goodsnum 乘数 |
|---|---|---|---|
| 代购 DG | VIP（utype=1 且在有效期） | `diff × 1.0` | `diff × 1.0` |
| 代购 DG | 普通 | `diff × 1.05` | `diff × 1.05` |
| 代发 DF | VIP | `diff × 1.0` | `diff × 1.0` |
| 代发 DF | 普通 | `diff × 1.0` | `(旧数量−新数量) × (goodsprice + dffee)` |
| 转运 ZY | 任何 | **跳过，不动余额** | 跳过 |

`diff = old(goodsprice×goodsnum) − new(goodsprice×goodsnum)`；流水 `action=5`（改价）/`action=6`（改量）。

**(c) 砍价联动 `OrderAmountSyncService`**（改价后按 **同一 tid 整单**重算）
- `bargainprice = Σ max(0, (goodsprice − goodsprice1) × goodsnum)`（逐行算，**汇总挂到 holder 订单**）
- holder = **同组最大 oid**（`sortByDesc('oid')->first()`；2026-03 前是最小 oid，已随 totalfee 统一改造修正——**历史数据可能两种口径并存**）
- 直接改整单 `bargainprice` → 按金额占比把 `goodsprice1` 分摊回各行（`round(...,2)`，允许 1~2 分尾差）
- 同步 `dg_sendorder.bargainprice` + `dg_fapiao.goodsprice/goodstotal/bargainprice/sendprice`
- 金额比较用**整数分**（`(int) round(x*100)`）；`BatchUpdateOrder` 用 `beginDeferredSync/flushDeferredSync` 提交后统一 flush 防重复跑

**(d) 运单已邮寄返金**（send-order 域动作，但钱从 order 的 bargainprice 出）
- `refundAmount = Σ order.bargainprice`；`sendprice = Σ order.sendprice`
- `dg_record.action=3` 扣国际运费；`action=11` 返剩余砍价 + 生成 `dg_rechargerecord` + `dg_sendorder.bargainstate=1`
- 总返金口径：`即时返（5/6） + 已邮寄返（11）`，理想值 = `用户原支付 − 实际采购`
- 发票发送有兜底幂等：已存在 action=11 则自动修正 bargainstate，防重复返金

**(e) 砍价风控展示**（2026-10-14 新增）：`Σ bargainprice > 商品总金额 × 30%` 红字预警；`bargainprice` 是**砍价总额不是单价**；会员端「安くなった額」是按 goodsprice/goodsprice1 推算的展示口径，**两个数不要互相替代**。

### 3.4 平台侧链路（`v2_ecommerce_order` → `dg_order`）

- 平台（amazon/shopify/ebay/rakuten/yahoo/mercari）订单同步落 `v2_ecommerce_order`（UK `(shop_id, unique_id)`）
- `confirmEcommerceOrder`（GraphQL）/ `AutoSyncEcommerceOrderToDgJob`（队列）转 `dg_order`：
  1. `Cache::lock` 订单级防重 → `DB::transaction`
  2. `EcommerceOrder::lockForUpdate()`（**行锁**）→ `validateItemsBeforeConfirm()`（所有 item 有有效供应商绑定：`purchasable_status=1 AND deleted_at IS NULL`）
  3. `validateUserBalance()`：`User::lockForUpdate()` 汇总需求金额，不足抛 `UserError` 整体回滚（**锁序：ecommerce_order → dg_users，防死锁**）
  4. `createDgOrdersFromEcommerceOrder()`：建 `dg_order`（`ORDER_TYPE_DAIFA`）→ `payOrder()` 扣余额 → `order_status=SUBMITTED(2)`
  5. Job 路径余额不足：`Log::warning` + 正常结束（**不重试**）
- `order_status`：-1 暂不处理 / 1 待处理 / 2 已提交订单；`is_fulfilled` 平台发货回写；`price` **varchar「价格+币种」**
- `Shop.auto_sync_orders` = 订单是否自动同步转 dg_order；`api_credentials` JSON（注释称加密，**需核实**）

### 3.5 tid 分组与 carrier/holder 机制（旧系统最深的坑）

- 业务现实：会员在 1688 一个店铺一次下单买 N 个商品 → **一个 tid → N 条 dg_order**（oids 逗号分隔出现在 sendorder/stores/fapiao 多处）
- 但「整单砍价总额」只有一列 `dg_order.bargainprice` → 旧系统用 **holder/carrier**  hack：整单价款挂在**同组某一个 oid** 上（现规则=最大 oid），其余行置 0
- 后台编辑哪条订单的 sendprice/bargainprice，哪条就成为新 carrier（`migrateAmountCarrierToSelf()`）——**管理员动作改变数据归属行**
- `finance-orders-bargain-amount-warning.md` 明示：`dg_sendorder.bargainprice`（运单砍价汇总）与 `dg_order.bargainprice`（整单砍价总额）**语义不同**，不可互替
- ➜ 新系统：显式 `OrderGroup`（§4.1）

### 3.6 幂等三道防线（旧系统已沉淀的正确实践，照搬）

| 防线 | 机制 | 归属 |
|---|---|---|
| ① 开放 API 幂等 | `v2_open_api_idempotency` UNIQUE `(uid, scope, client_key)` + `request_hash`（同键换内容→422）+ 原样返回首次 response | member 域（已建模） |
| ② 下单防重映射 | `v2_order_client_ref` PK=oid，INDEX `(uid, client_order_id)` | **order 域（本文）** |
| ③ 并发锁 + 冷却 | 同一批购物车 gid 请求锁 + SKU 处理锁（Redis，TTL 300s，结束即释放）；**下单成功后**同用户同 SKU 30 秒冷却；失败不写冷却可立即重试 | order 域创建服务 |

要点（`member-open-api-create-order.md`）：加购+下单**同一事务**；`goods_list` ≤20 条；拉实时价在 Redis 处理锁内、DB 行锁外（避免长事务）；`add_from` 服务端固定 8 客户端不可覆盖。

### 3.7 导入 / 询价 / 购物车入口

- **导入**（`dg_imporder`/`_detail`）：Excel/API → `ProcessOrderImportJob` 异步处理；明细 state：0 初建/1 异常url/2 taobao 获取成功/3 接口获取错误/4 下单成功/5 主单信息错误；`original_oid` 有值 = 拆分单；`sku_name` 按规格匹配平台 SKU 图/价（属性顺序无关）；`maxprice` 价格上限
- **询价**（`dg_inquiry_order`/`_item`）：status 0 待报价/1 部分报价/2 已报价/3 已关闭/**4 已下单**（防重复建单）；必须全部子单已报价才能建单；`quoted_amount` 是**报价单价**（乘 quantity 得总价）；复用购物车转订单链路；`extend.inquiry.product_remark` 回填
- **购物车**（`dg_cart`，697 万行）：`type` 1 代购/2 代发货（由用户 dfflag 决定）；`offer_price`/`retail_price`/`one_piece_price` 三价并列；`min_order_quantity`（1688 最小起批，**按同商品全部 SKU 合计校验**）；`goods_name_trans`/`sku_trans` 翻译；var1-12/yanhuo 检品快照与 dg_order 同构

### 3.8 售后 / 检品 / 物流单号 `_S` 后缀

- 进入售后（9/12）给 `expressno` 追加 `_S`；**仅改回在途(3) 去掉**；改到检品中/入库等保留
- 补发打印：`基础号_N`（N=当前最大序号+1，**按批 +1 不按勾选数**）；仓储按旧号/`_S` 家族号命中合并，不因新序号新建重复仓储
- `dg_stores.expressno` 同步更新（同 uid+旧号；目标键已存在则跳过防 uk 冲突）；打印标签进 9/12 **不建仓储、不改仓储号、从 oids 去掉售后订单**
- `v2_logistic_domestic` 仍存**原始物流号**（不同步后缀）
- 检品记录 `dg_examination_record`：oid/tid/expressno/item_id 四键可查，`reason`+`detail`+`detail_ja`（中日双语）+`images`；与订单多对多（`relation_order_and_examination_record`）

### 3.9 规模数据（决定回填策略）

| 表 | 行数（AUTO_INCREMENT） | 迁移注意 |
|---|---|---|
| `dg_order` | 5,872,062 | 热表；**生产在写**；双写必须同库同事务 |
| `dg_cart` | 6,967,548 | 可只迁活跃购物车（历史归档） |
| `dg_yunjiao` | 2,930,320 | 站内信大表，按 uid 分片 |
| `v2_order_auto_created` | 3,155,404 | 高频；只回填未完结 |
| `dg_fapiao` | 4,458,295 | 归 send-order 域 |
| `relation_order_and_operation_record` | 22,159,744 | 归 admin 域，不随 order 迁 |
| `v2_relation_order_and_logistic_domestic` | 10,202,098 | 归 logistics 域 |

---

## 四、关键建模决策（逐条给理由）

### 4.1 `OrderGroup` 显式化：bargainAmount 挂组，删除 carrier/holder

- 旧：tid 分组**隐式**（无表），整单砍价挂某个 oid，管理员改单可迁移 holder，`sendorder/stores/fapiao` 全靠逗号分隔 oids 找组
- 新：`order_groups` 表 —— `tid` UNIQUE（可空：无平台交易号的手动建单自成一组）、`memberId`、`shopId`（供应商店铺快照）、**`bargainAmount` Decimal(14,2) 整单砍价总额**、`bargainRefundedAt`、`supplierShopId`
- `orders.groupId Int?` → 组。砍价重算只动组一行；`goodsprice1`（砍后单价）作为行的派生展示值
- ➜ **收益**：holder/carrier/migrate 整套机制删除；`dg_sendorder.oids`、`dg_stores.oids` 的字符串拆分改 `groupId` 关联；30% 砍价风控从「按 tid 分组汇总」变成组级一行
- ⚠ 回填：按 `dg_order.tid` 分组建组；**空 tid 的订单**（`loadAmountCarrierCandidateOrders` 已处理该分支）每单独立成组；原 holder 行（最大 oid）的 bargainprice 迁入组，其余行置 0 的记录直接丢弃

### 4.2 金额：float → `Decimal(14,2)` + 「对客价 / 采购成本价」双列显式化

- 旧 `dg_order` **7 个金额列全 float(10,2)**（`goodsprice/goodsuprice/sendprice/senduprice/bargainprice/proprice/inspection`）；`v2_order_detail.coupon_fee/seller_change_amount` 也 float
- 新：一律 `Decimal(14,2)`（2026-10-15 Q8 定版）；★ **对客列与采购成本列是同一币种 CNY**（原判「对客 JPY / 采购 CNY」不成立，见 `finance-schema.md` §3.3 与 Q1 改判），分组命名要区分的是**价格维度**不是币种：
  - `unitPrice`（对客价）、`bargainedUnitPrice`（砍后对客价）
  - `purchaseUnitPrice`（采购成本价）、`purchaseShippingFee`（采购国内运费）
  - `shippingFee`（对客运费）
- 汇率换算归 **finance 域**（`fee_rules` + `exchange_rates`），order 只存快照。★ 注意 `dg_users.floatrate` 已判**死列**（全仓仅后台详情读它，无任何计算读取），真实浮动是三菱 +0.5 / Yahoo +0.8 硬编码加点
- `v2_ecommerce_order.price` varchar「价格+币种」→ `totalAmount Decimal(14,2)` + `currency`（§4.8）——这里的 `currency` 是**外部平台自己的币种**（JP 平台确实 JPY），与本系统账本面值无关，别混为一谈

### 4.3 服务端重算：每一次资金变动都是 ledger 事件

- `payOrder()` 的 5% 服务费、`dffee`、`AMTLIMITFEE=1.05`、1.05 即时结算乘数 —— **全部从模型层硬编码搬到服务端计费服务**（入参：订单快照 + 会员身份；出参：金额 + 计费明细）
- 新系统 order 域**不碰余额**：扣费/返金一律产生 finance 事件（`ledger_entry`），order 只落 `*_at` 状态与 `chargedAmount` 快照
- `deducted_service_fee`（extend 里的服务费抵扣）→ 显式列 `serviceFeeOffset`
- 旧「即时返金 + 已邮寄返金」两段式口径保留为业务规则，但**每段各写一条 ledger**，禁在 order 上做加减

### 4.4 状态机 cas + 显式迁移表 + 状态历史

- `status` 用 Int + contract zod enum（沿用 member 域约定）；**禁「先查后改」**：`UPDATE orders SET status=? WHERE id=? AND status=?`
- 新表 `order_status_histories`（oid, fromStatus, toStatus, operatorType, operatorId, reason, createdAt）—— 同时替代 10 个状态时间戳列（§3.1），`state_entered_at` 只留当前态进入时间
- 迁移表白名单（§3.2 已核实部分）+ 未核实迁移一律拒；`invalidStates=[6,10,11]` 参与金额计算的过滤条件集中一地
- ⚠ 历史数据两种 holder 口径（最小/最大 oid）并存提醒回填脚本注意

### 4.5 关系只存一侧：禁 `SendOrder.oids` 双写

- 旧：`dg_order.sid` 与 `dg_sendorder.oids`（mediumtext 逗号分隔）**双向存关系**，解绑要两边改、删运单要回写 sid=0
- 新：只存 `orders.sendOrderId Int?` 一侧；运单侧反查。取消运单 = 清 `sendOrderId` + 状态回 4（cas），**无字符串拼接**

### 4.6 var1-var12 / yanhuo 家族 30+ 列 → 结构化检品选项

- 旧：`var1`~`var12`（11 个勾选 + 1 个自由文本）+ `yanhuo*` 5 列 + 平台标签 9 列（SKU/FNSKU/name/amazon/putong/tiebiao/huanbaoz/fuzhuang/qita/baozhuang/hbbaozhuang/baonum），**列名即语义，schema 无注释，对接方传错值无法校验**（已发生 `"0"` 误写入事故，见 open-api 文档未完成项）
- 新：`OrderInspectionOption` 子表（`orderId` + `code`（contract 枚举词表：`special_inspection`/`detail_photo`/`normal_photo`/`full_unboxing`/`fba`/`asin`/`fnsku`/…）+ `enabled Boolean` + `textValue String?`）或 JSON `inspectionOptions` + contract 校验；强类型列只留 `asin`/`fnsku`/`fbaShipmentId`
- 布尔语义：只有 `true` 算勾选；**禁 `"1"`/`"0"` 字符串布尔**
- Cart 同步改造（同构字段一起收敛）

### 4.7 来源枚举合并：`add_from` + `purchase_type` + `add_from_memo`

- 旧两套重叠枚举（add_from: 0老网站/1新网站/2插件/3重下单/8API；purchase_type: 0一键/1手动/2自动）
- 新：`source`（web / mzk / admin / api / import / plugin）+ `creationMode`（one_click / manual / auto）+ `sourceRef String?`（原 add_from_memo / client_order_id 等）

### 4.8 「价格+币种」varchar → amount + currency

- `v2_ecommerce_order.price`、`v2_ecommerce_order_item.unit_price/total_price` 全是 varchar(50)「价格+币种」字符串
- 新：`Decimal(14,2)` + `currency`（ISO 4217）；平台原始串入 `rawSnapshot` JSON 备查

### 4.9 INT unix → `DateTime(0)`

- 旧 `dg_order` 13 个时间列全 INT unix 秒；`paytime` 注释「采购下单时间（非付款时间）」是命名坑
- 新：`DateTime(0)`（对齐旧精度，禁假精度）；生产库会话时区 +08:00，回填用 `FROM_UNIXTIME`，禁 PHP `date()` 直转（会偏 8 小时）

### 4.10 禁冗余 `uname`/`memberid`：JOIN member

- 旧 `dg_order` 冗余 uname/memberid（并为此建了 `idx_uname_and_type_and_state`、`idx_addtime_and_memberid` 等索引）——快照思维，会员改名后订单显示旧名反而成了「特性」
- 新：只存 `memberId`；展示名/客户代号经 member 取。**打印/导出场景的「历史客户代号」需求**用 `memberIdSnapshot`? —— 不，仍禁冗余；打印时实时 JOIN（量小）
- `belong_company`（HHO/Gouba）是**业务隔离维度不是冗余**，保留为列

### 4.11 `mark_flag` 位运算 → 显式列

- `mark_flag int` 按位存客户自定义标识（`getMarkFlagAttribute` 位移读写）
- 新：`isFavorite Boolean @default(false)` 等显式布尔列（词表在 contract）；禁位运算列

### 4.12 oid 主键对齐 + 同库双写（过渡期）

- 回填 `orders.id == dg_order.oid`（显式带 id + `PREPARE` 顶 AUTO_INCREMENT=MAX(id)+1，**不能用行数**——旧表有 id 空洞，max uid 25,289/实 22,612 的教训）
- `order_groups` 用新自增 id + `legacyTid` 映射列（旧 tid 是 varchar，直接做 UNIQUE 会与大小写/尾空格 collation 坑纠缠——参照 member.username 的 `utf8mb4_general_ci` 教训，**tid 列显式 general_ci**）
- float→Decimal 回填无损（旧值两位小数）；INT 时间戳用 SQL `FROM_UNIXTIME`

### 4.13 索引：照搬旧表「真正被用到的」

- `orders`：`(memberId, createdAt)`（旧 idx_uid_and_addtime）、`(status)`、`(groupId)`、`tid`（UK 在组表）、`outid`、`(source, createdAt)`
- `order_client_refs`：`(memberId, clientOrderId)`（**下单防重查询路径**）
- `order_platform_creations`：`(platformTradeId, platformSubTradeId)`（旧 idx_tid，webhook 幂等查找）、`orderId`
- `platform_trade_amounts`：`(tid, platform)` UNIQUE（照搬）
- `platform_orders`：`(shopId, uniqueId)` UNIQUE（照搬）
- `order_messages`：`(orderId, createdAt)`、`(memberId, createdAt)`
- `examination_records`：`oid`/`tid`/`expressno`/`itemId`（旧四索引照搬）
- ⚠ 旧表 20+ 索引多数为 admin 查询服务（idx_goodsseller/idx_paytime/idx_uptime…），新系统按实际查询面重建，**不照搬**

---

## 五、Prisma schema 草案（核心模型字段级）

> 完整 schema 待本节评审后落入 `packages/db/prisma/schema.prisma`（order 段）。命名纪律：snake_case `@map`、金额 Decimal、禁外键（`relationMode="prisma"`）、枚举用 Int/String + `///`。

```prisma
/// 采购单分组（tid）。旧系统无此表：整单砍价挂在某个 oid 上（holder 机制），本表使其显式化
model OrderGroup {
  id        Int      @id @default(autoincrement())
  /// 平台交易号（1688 一次店铺下单 = 一个 tid）。NULL = 未关联平台的手动建单
  tid       String?  @unique @db.VarChar(64) // ⚠ 列级 collation utf8mb4_general_ci 需 raw SQL MODIFY（Prisma 不支持）
  memberId  Int      @map("member_id")
  /// 供应商店铺快照（supplier 域 shop_id；禁外键）
  supplierShopId Int? @map("supplier_shop_id")
  /// 整单砍价总额（原 dg_order.bargainprice holder 列）——组级唯一正本
  bargainAmount    Decimal  @default(0.00) @map("bargain_amount") @db.Decimal(14, 2)
  /// 砍价是否已返（原 dg_sendorder.bargainstate 的 order 侧对照）
  bargainRefundedAt DateTime? @map("bargain_refunded_at")
  /// 订单行汇总运费快照（原 sendprice 按 tid 汇总）
  shippingFeeTotal Decimal  @default(0.00) @map("shipping_fee_total") @db.Decimal(14, 2)
  orders    Order[]
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([memberId, createdAt])
  @@map("order_groups")
}

/// 订单行（oid 语义）。旧源 dg_order：一行 = 一个商品
model Order {
  id        Int      @id @default(autoincrement()) // == 旧 dg_order.oid（回填对齐）
  groupId   Int?     @map("group_id")              // 旧 tid 分组；空 = 独立单
  memberId  Int      @map("member_id")
  /// 1 代购 2 转运 3 一件代发（contract OrderType）
  type      Int      @db.SmallInt
  /// 12 态状态机（contract OrderStatus，§3.2）；cas 更新
  status    Int      @default(1) @db.SmallInt
  statusEnteredAt DateTime @default(now()) @map("status_entered_at")
  /// web/mzk/admin/api/import/plugin（旧 add_from 8=api 等合并）
  source    String   @db.VarChar(16)
  /// one_click/manual/auto（旧 purchase_type）
  creationMode String @default("one_click") @map("creation_mode") @db.VarChar(16)
  sourceRef String?  @map("source_ref") @db.VarChar(64) // 旧 add_from_memo
  /// 客人外部管理号（旧 outid，对接方重要）
  outId     String?  @map("out_id") @db.VarChar(80)
  /// HHO/Gouba 双公司（业务隔离维度，非冗余）
  belongCompany String? @map("belong_company") @db.VarChar(32)

  // ---- 商品快照（旧系统全量冗余，保留：订单是历史事实）----
  goodsId       String  @map("goods_id") @db.VarChar(20)
  goodsUrl      String  @map("goods_url") @db.VarChar(512)
  goodsName     String  @map("goods_name") @db.VarChar(255)
  goodsImg      String? @map("goods_img") @db.VarChar(255)
  skuName       String  @default("") @map("sku_name") @db.VarChar(1024)
  goodsSeller   String? @map("goods_seller") @db.VarChar(50)
  goodsSite     String? @map("goods_site") @db.VarChar(50)
  /// supplier 域引用（禁外键）
  supplierShopId    Int? @map("supplier_shop_id")
  supplierProductId Int? @map("supplier_product_id")

  // ---- 数量与金额（§4.2 双币种分组）----
  quantity    Int     @default(1)
  /// 对客单价 CNY（旧 goodsprice）
  unitPrice   Decimal @default(0.00) @map("unit_price") @db.Decimal(14, 2)
  /// 砍后单价 CNY（旧 goodsprice1；由 OrderGroup.bargainAmount 分摊派生）
  bargainedUnitPrice Decimal @default(0.00) @map("bargained_unit_price") @db.Decimal(14, 2)
  /// 对客运费 CNY（旧 sendprice）
  shippingFee Decimal @default(0.00) @map("shipping_fee") @db.Decimal(14, 2)
  /// 采购单价 CNY（旧 goodsuprice）
  purchaseUnitPrice Decimal @default(0.00) @map("purchase_unit_price") @db.Decimal(14, 2)
  /// 采购国内运费 CNY（旧 senduprice）
  purchaseShippingFee Decimal @default(0.00) @map("purchase_shipping_fee") @db.Decimal(14, 2)
  /// 验货金额 CNY（旧 inspection）
  inspectionFee Decimal @default(0.00) @map("inspection_fee") @db.Decimal(14, 2)
  /// 下单时实扣金额快照（payOrder 服务端重算结果；正本在 ledger）
  chargedAmount Decimal @default(0.00) @map("charged_amount") @db.Decimal(14, 2)
  chargedCurrency String @default("CNY") @map("charged_currency") @db.VarChar(3)
  /// 服务费抵扣（旧 extend.deducted_service_fee）
  serviceFeeOffset Decimal @default(0.00) @map("service_fee_offset") @db.Decimal(14, 2)

  // ---- 物流/到库（§4.5 关系只存一侧；§4.7 后缀显式化）----
  sendOrderId  Int?    @map("send_order_id")   // 旧 sid；只存这一侧
  /// 国内物流号（旧 expressno）——存原始号，禁 _S 后缀编码
  domesticTrackingNo String? @map("domestic_tracking_no") @db.VarChar(100)
  /// 补发序号（旧 _N 后缀显式化；NULL = 非补发）
  reissueSeq   Int?    @map("reissue_seq")
  /// 是否售后包裹（旧 _S 后缀显式化）
  isAfterSale  Boolean @default(false) @map("is_after_sale")
  weightGrams  Int?    @map("weight_grams")     // 旧 orderweight
  /// 1 空运 2 海运 3 敏感货（旧 ship）
  shipMethod   Int?    @map("ship_method") @db.SmallInt
  /// 敏感货标记（旧 flag：2 是 1 不是）
  isSensitive  Boolean @default(false) @map("is_sensitive")

  // ---- 代发/库存（WMS 边界）----
  /// 一件代发库存单（旧 dfstoremode=1）；库存台账归 WMS
  dfStoreMode  Boolean @default(false) @map("df_store_mode")

  // ---- 条款与标记 ----
  /// 数量不足按库存购买/价格多退少补/国内运费多退少补（旧 TermQty/TermPrice/TermShipping）
  terms        Json?   // { qtyShortBuy: bool, priceAdjust: bool, shippingAdjust: bool }
  /// 紧急订单（旧 isjinji varchar 当布尔）
  isUrgent     Boolean @default(false) @map("is_urgent")
  /// 收藏标识（旧 mark_flag 位运算 → 显式列）
  isFavorite   Boolean @default(false) @map("is_favorite")

  // ---- 备注族（旧 goodsremark1-4/mremark/orderremark/buyer_memo 六列）----
  buyerRemark  String? @map("buyer_remark") @db.VarChar(512)
  adminRemark  String? @map("admin_remark") @db.VarChar(512)

  createdAt DateTime @default(now()) @map("created_at") // 旧 addtime
  updatedAt DateTime @updatedAt @map("updated_at")      // 旧 uptime
  deletedAt DateTime? @map("deleted_at")

  group            OrderGroup?         @relation(fields: [groupId], references: [id])
  extension        OrderExtension?
  platformCreation OrderPlatformCreation?
  messages         OrderMessage[]
  examinations     OrderExamination[]

  @@index([memberId, createdAt])
  @@index([status])
  @@index([groupId])
  @@index([outId])
  @@index([source, createdAt])
  @@map("orders")
}
```

其余模型字段级草案（评审后同批落 schema）：

| 模型 | 关键字段（新名 ← 旧名） | 唯一键 / 索引 |
|---|---|---|
| `OrderExtension` | orderId（=oid 1:1）← `v2_order_detail.id`；`goodsNameTrans`；`skuTrans Json`；`couponFee Decimal`（float→Decimal）；`sellerChangeAmount Decimal`；`instantChatTag` | PK=orderId |
| `OrderClientRef` | orderId（=oid）；memberId；`clientOrderId`（幂等键） | PK=orderId；INDEX (memberId, clientOrderId) |
| `OrderPlatformCreation` | orderId；`platform`（1688/taobao_global←type）；`creationMode`（one_click/manual←add_from）；`platformSubAccountId`；`platformTradeId`；`platformSubTradeId` | INDEX (platformTradeId, platformSubTradeId)、orderId |
| `PlatformTradeAmount` | platform；tid；first/latest 两组快照（`stage` 单调：created<sync<price_modified<paid，**只前进**）；`goodsTotal`/`shippingFee`/`totalAmount`/`couponFee`/`sellerAdjust` Decimal；`rawSnapshot Json`；paidAt | UNIQUE (tid, platform) |
| `PlatformOrder` | shopId；`uniqueId`；`platformOrderSn`；`platformOrderStatus`（原始串）；`platformModifiedAt`；`detail Json`；`status`（-1/1/2）；`isFulfilled`；`fulfillmentFailureReason`；`totalAmount Decimal`+`currency`（varchar 拆分）；`shippingInfo Json`；`orderedAt` | UNIQUE (shopId, uniqueId) |
| `PlatformOrderItem` | orderId；skuId；quantity；`unitPrice Decimal`+`unitCurrency`；`totalPrice`+`totalCurrency`；`productSnapshot Json` | UNIQUE (orderId, uniqueId) |
| `Shop` | memberId；platform；`uniqueId`；name；url；`marketplaceId`；`sellerId`；`apiCredentials Json`（**加密，需核实旧实现**）；currency；timezone；status（0待审核/1激活/2暂停/3已删除）；connectionStatus；`useStore`；`autoSyncOrders`；`lastSyncAt`；deletedAt+**restoredAt**（可恢复软删）+deletedByMemberId+restoredByMemberId | INDEX (memberId, platform)、(status) |
| `PlatformProduct` | shopId；uniqueId；name；goodsUrl；imgUrl；platformStatus | UNIQUE (shopId, uniqueId) |
| `PlatformProductSku` | shopId；productId；uniqueId；sku；fnsku；name；imgUrl；`attribute Json`；`price Decimal`；`platformInventory Json` | UNIQUE (productId, uniqueId) |
| `PlatformSkuOrderLink` | skuId；orderId | UNIQUE (skuId, orderId) |
| `OrderSplit` | orderId（主单）；`splitFromOrderId`（被拆原单←spoid）；quantity；memberId | INDEX orderId、splitFromOrderId |
| `InquiryOrder` | `inquiryNo` UNIQUE；memberId；status（0待报价/1部分/2已报价/3关闭/4已下单）；poFileUrl；quotationFileUrl；itemCount；quotedItemCount | INDEX (memberId, isDeleted, createdAt) |
| `InquiryOrderItem` | `inquiryItemNo` UNIQUE；inquiryNo；productTitle（+trans）；sellerName；quantity；specDesc（+trans Json）；productId；skuId；productRemark；`productPrice Decimal`；**`quotedUnitPrice Decimal`（报价单价，非小计）**；productUrl；productSite | INDEX (inquiryNo, productId, skuId) |
| `ImportBatch` | memberId；type（1代购/3代发）；status（0初建/1申请处理/2处理中/3成功/4异常）；memo；fileName；notifyState（0无需/1未通知/2中/3成功/4失败） | INDEX memberId、addtime |
| `ImportItem` | batchId；memberId；goodsUrl；goodsName；goodsId；`supplierProductId`；goodsImg；goodsSite；`unitPrice Decimal`；quantity；skuName；color；size；seller；remark；**df 收件人族**（consignee/tel/zip/address）；outId；status（0初建/1异常url/2获取成功/3接口错误/4下单成功/5主单错误）；proInfo；`orderedAt`；orderId（建单结果）；`dataFrom`（excel/api）；`maxPrice Decimal`；**originalOrderId（拆分来源）** | INDEX outId、orderId、batchId |
| `OrderInvalidMark` | orderId；adminId；type（1-1688/2-淘宝）；itemId；status（1禁运）；extra Json；memo | INDEX orderId、itemId |
| `OrderMessage` | orderId；memberId；status；`boxNo`（旧 xbox）；`assignee`（旧 xz）；operator（旧 user）；`userContent`/`adminContent`（旧 ucon/xcon）；images；`isFocused`/`isUserFocused` | INDEX (orderId, createdAt)、(memberId, createdAt) |
| `ExaminationRecord` | orderIds（经关系表）；tid；domesticTrackingNo；`orderType`；itemId；creatorId；salesman；reason；detail（+detailJa）；images；status；extra；memo | INDEX tid、expressno、itemId、createdAt |
| `OrderExamination` | orderId；examinationId | INDEX 双侧 |
| `Cart` | memberId；type（1代购/2代发←由 dfflag 决定）；商品快照同 Order；`offerPrice`/`retailPrice`/`onePiecePrice` Decimal；`minOrderQuantity`；翻译列；检品选项（§4.6 同构收敛）；`clientRef`（匿名袋 anonymous） | INDEX (memberId, type, createdAt) |

---

## 六、过渡期共存策略（沿用 Q7：新表正本 + 同库事务双写）

1. **双写范围**：新系统写 `orders`/`order_groups`/`order_extensions`/`order_client_refs` 等 + 旧 `dg_order`/`dg_sendorder`/`v2_order_detail`/`dg_stores`（旧系统视角的正表）在**同一 MySQL 同一事务** upsert。读只读新表。
2. **主键对齐**：`orders.id == dg_order.oid`；`order_groups` 新 id + `legacyTid` 映射列（回填后旧系统 tid 关联不改）。
3. **精度与时区**：float→Decimal 无损；INT 时间戳统一 SQL `FROM_UNIXTIME`（禁 PHP date 直转，+08:00 坑）。
4. **carrier 回填**：按 tid 建组，holder（最大 oid）bargainprice 迁入组；**注意历史最小 oid 口径数据**（2026-03 前）。
5. **反向同步（T1→T2）**：旧系统 GraphQL/admin/Job 仍会写 `dg_order`（`uptime` 水位增量合并回新表），直到 T2 关闭旧写入口。
6. **热表分批**：`dg_order` 587 万行回填按 oid 分片 + 短连接（生产跳板机隧道长连接不稳，PHP `MySQL server has gone away` 教训）；`dg_yunjiao`/`dg_cart` 大表可只迁活跃数据。
7. **切换时序**：T0 建新表 → T1 回填+读新写双 → T2 切写入口 → T3 旧表降级只读投影（供未切换域 JOIN）。

---

## 七、与 contract 的边界

- `packages/contract/src/domains/order.ts` 是**唯一**对外类型源；Prisma 类型禁入路由出参（docs/07 c2）。
- 词表（zod enum + 常量）：`OrderType`（1/2/3）、`OrderStatus`（12 态）、`OrderSource`、`CreationMode`、`PlatformTradeStage`（created/sync/price_modified/paid）、`InspectionOptionCode`（替代 var1-12 的受控词表）、`ShopStatus`/`ConnectionStatus`、`ImportItemStatus`、`InquiryStatus`
- 开放 API 入参（`/api/v1/orders`）**服务端全覆盖校验**：`goods_list` ≤20、`quantity ≥1`、布尔只认 true（禁 `"1"`/`"0"` 字符串）、`add_from` 服务端固定 api 客户端不可传
- 多态（`ticketable` 指向 Order）契约层禁暴露 `*_type` 原始字符串（沿用 member 域 3.5 决策）

---

## 八、未决问题（需业务/用户确认）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | `dg_order.payid` 语义？（代码仅 fillable + 索引，无业务逻辑） | 是否保留该分组维度 |
| Q2 | `pinoid`/`pinnum`（拼单遗留）是否还有业务在用？ | 不建模则回填丢弃 |
| Q3 | `dg_fapiao`（发票）归 send-order 还是 order 域？（本文建议 send-order：sid 维度 + 发票事件表都在那边） | 域边界 |
| Q4 | `dg_otype`（商品分类）、`typeid` 归属 cms 还是 supplier 域？ | 字典归属 |
| Q5 | ~~`OrderGroup` 显式化方案是否采纳？~~ **✅ 已拍板采纳（2026-10-14）**：显式 `order_groups` 表，bargainAmount 挂组级，carrier/holder 整套删除；实测 99.58% 持值行在组内最大 oid、186 个多行持值异常组按 SUM 汇总天然兼容。详见 `05-order-group-评审与拍板.md` | ★ 已拍板 |
| Q6 | Excel 导入（`dg_imporder`）是否继续支持？若保留，导入→建单是否仍走购物车链路 | ImportBatch 建模深度 |
| Q7 | 服务费 5%、`dffee`、`AMTLIMITFEE=1.05`、1.05 即时结算乘数——费率配置化后归 finance 域哪个服务？ | 计费服务边界 |
| Q8 | `v2_ecommerce_shop.api_credentials` 旧实现是否真的加密？（dump 注释称加密存储，需核实代码） | 凭证安全 |
| Q9 | `dg_order.extend` 里除 `deducted_service_fee`/`inquiry` 外还有哪些键在用？ | JSON 列契约化 |
| Q10 | `mark_flag` 位定义的完整位表？（`MARK_FLAG_FAVORITE` 等，需从代码反查，同 TODO #3b） | §4.11 显式列清单 |
| Q11 | 历史两种 holder 口径（最小/最大 oid）在存量数据中各占多少？是否需要订正脚本 | **✅ 已收口（随 Q5 拍板）**：SUM 汇总口径无关，不订正；实测 99.58% 符合最大 oid，238 个例外随 SUM 天然处理（见 `05-order-group-评审与拍板.md` §4.2/§七） |

---

## 九、下一步

1. ~~评审 §四决策（重点 Q5：OrderGroup 显式化）~~ ✅ **已拍板（2026-10-14）**，见 `05-order-group-评审与拍板.md`（实测：99.58% 持值行在组内最大 oid、186 个多行持值异常组 SUM 天然兼容）
2. 反查 Q1/Q2/Q9/Q10 的字段语义（旧代码只读，同 #3b 枚举反查）——**Q10 已部分收口**：`mark_flag` 是 2bit 一态打包（favorite 占位 0-1、arrival 占位 2-3，值域 0-3），已落 `isFavorite`/`arrivalMark` 两列
3. ~~生成 T0 建表 DDL~~ ✅ **已完成**：`0002-order-domain-up.sql`（26 表，schema.prisma 增量 diff 生成）+ `0002a-order-tid-collation.sql`（tid 家族 4 列 general_ci）
4. 精读 send-order 域 → `docs/plans/send-order-schema.md`（`dg_sendorder` 812 行模型 + `v2_send_order_label` 长流程 + totalfee 统一改造文档）
5. order 域 contract 定义（`packages/contract/src/domains/order.ts`）
6. ~~T1 回填脚本 + 本地演练~~ ✅ **已完成**：`0006`（源导入）→ `0007`（核心三件套，分片存储过程）→ `0008`（19 张侧表）→ `0009`（21 项断言）。本地实测：orders 73,291（78% uid 孤儿被 JOIN member 过滤，本地副本所致）、组 26,078、砍价总额 372,331.23 与源分毫不差、断言全 PASS、两遍幂等。演练坑位（ANALYZE / collation 1267 / OR 关联禁入 / REGEXP_SUBSTR 语法）已写入 `packages/db/sql/README.md`

**落地实况（2026-10-14）**：`schema.prisma` order 段 **26 个模型** = 草案 22 + `OrderStatusHistory`（§4.4 决策）+ `PlatformSubAccount`（`v2_platform_sub_account`，`v2_order_auto_created` 的引用目标）+ `OrderValueAddedService`/`CartValueAddedService`（`v2_*_value_added_service`，草案外补充的真实收费表）。对草案的字段级修正：`goodsId`/`goodsUrl` 改可空（源列可空，禁造空串）、补 `promoPrice`/`orderImg`/`dfGoodsName`/`reissueNo`/`xzAssignee`/`payId`、`isFavorite`+`arrivalMark` 拆包替代单位布尔、`remarksExtra`/`extendExtra`/`legacyStateTimes` 三个 JSON 兜底列（六列备注族 / extend / 13 个时间戳）。
