# send-order 域未决问题评审与拍板（2026-10-15）

> 对象：`docs/plans/send-order-schema.md` §八 十条未决问题
> 依据：本地 `taotaro` 副本实测（`dg_sendorder` 18,078 行 / `dg_fapiao` 371.8 万行 / `v2_sendorder_value_added_service` 36 行）+ 旧系统代码只读精读
> 结论先行：**Q3 拍板归 send-order**；Q1/Q2/Q5/Q6/Q7/Q10 全部以数据收口；Q4/Q8/Q9 留待生产核实或切片时处理

---

## 一、Q3 拍板：`dg_fapiao` 归 send-order 域 ★

**采纳本文建议（§4.6）。理由（数据支撑）：**

1. **关联枢纽是 sid 不是 oid**：`dg_fapiao` 的 `sid`/`oid`/`uid` 三维中，本地 131,290 行有效发票覆盖 **4,793 个 sid / 129,704 个 oid**——即「一运单多发票、一订单一发票」，发票天然挂在运单下；同维度关联的 `dg_shelves.sid`、`dg_airbill.sendid` 全部按 sid
2. **发票生命周期字段全在运单上**：`havefapiao`/`fapiaotime`/`invoice_completed_at`/`invoice_completed_type`（系统/人工生成）四列在 `dg_sendorder`；`v2_send_order_invoice_event`（修订请求/付款确认 + 版本号）也是 sid 维度
3. **order 域不持有任何发票字段**：`dg_order` 无发票列；order-schema.md §五 22 实体也无发票实体——归 order 域需要新建关联，归 send-order 是顺接
4. **446 万行回填归属 send-order T1**：按 `JOIN send_orders` 过滤孤儿（本地 96.5% 孤儿系 sendorder 副本不全所致，生产孤儿率待测），主键 `fid` 对齐

**边界细则**：

- `invoices` 表归 send-order；order 域在下单/改单时提供金额快照（`goodsPrice` 等列本就来自订单快照，不反查 order 表）
- 发票的「开票金额计算」若涉及订单金额重算，走 contract 跨域调用，禁 send-order 直接 import order 模块

---

## 二、Q1 收口：`xiwgfei` 保留 nullable 列

- 本地 18,078 行**全 0.00**，旧代码 fillable 但无业务逻辑读写点
- 决策：保留 `damageFee Decimal?`（可空，审计兜底）；生产若有非零值随回填落列，**不**为此建业务逻辑。语义查明前禁入任何计算公式

## 三、Q2 收口：`countweight` 是千克小数字符串 → 克

- 本地抽样：`1.1` / `0.51` / `0.41` / `20`——**十进制千克**字符串（非逗号分隔列表）
- 决策：`chargeableWeightGrams Int?` = `ROUND(CAST(countweight AS DECIMAL) * 1000)`；不可解析（非数字/空/'0'）→ NULL，原值入 `legacyExtra`
- 对照：`dg_fapiao.totalweight` 是**另一套口径**（值域含 `A` 这种代码值 + `20`/`40` 数字）→ `totalWeight String? @db.VarChar(32)` 原样保留，语义待查（不猜、不转数值）

## 四、Q5 收口：`mark_flag` 本地全 NULL，不拆包

- 本地 18,078 行 `mark_flag` 全 NULL；旧代码未找到该列的位读写点（与 order 域 `mark_flag` 有明确 favorite/arrival 位不同）
- 决策：`markFlags Int?` 可空原样列，**不拆包**（无数据无位定义，拆包是造字典）；生产若发现非空值再议

## 五、Q6 收口：渠道是自由字符串，`did`/`passtype` 废弃化

- `deliveryname` 本地 14 个值（ヤマト急便 4,582 / 佐川急便 3,458 / ZC航空便 2,818 / EMS 1,868 / 日本郵政船便 1,478 / OCS 1,103 / TW閩専線…VIP 856 / TW閩専線 787 …）——**无字典表**，是运营自由填写的字符串
- `did` 与 deliveryname 不对应（did=0 对应 EMS/OCS 两种，did=NULL 也有值）→ **不建模**
- `passtype` 本地全 0 → `passType Int?` 可空列，词表待生产核实
- 决策：`deliveryChannel String? @db.VarChar(30)` 存 deliveryname 原值；contract 层「观察值枚举 + 容错新值」（禁严格 enum——运营会加新渠道）

## 六、Q7 收口：同捆纯组织关系，无金额汇总语义

- 本地 51 个子运单（parent_id>0）**全部 totalfee>0**——子运单独立计费；父子 totalfee 无加和关系（如父 17,533.00 vs 子 4,278.30，父还有其他子单/自有订单）
- 子运单持有**自己的 oids**（主运单 oids 含全部子单订单是冗余展示）
- 决策：`bundledIntoId` 纯组织关系（捆一起发货/作业），**禁做金额 rollup**；业务若要「同捆组总费用」按查询现算，禁存汇总列

## 七、Q10 收口：`sn` 是 `#` 连接的多运单号 → 首段 + 全量 JSON

- 本地最长 **363 字符**（23 行 >64）：样本 `CP544195012CN#CP544195030CN#CP544195030CN#…`——**`#` 分隔的多个快递单号**
- 决策：`sn String? @db.VarChar(64)` 存首段（常规单就是完整单号）；含 `#` 的多值行：首段入 `sn`，**全量拆分数组**入 `snExtra Json`（`{trackingNumbers: [...]}`）——保全数据 + 显式化语义，禁截断丢失
- 断言：`CHAR_LENGTH(sn) <= 64` 全表必须成立（超长必须已拆入 snExtra）

## 八、字段级补充发现（落 schema 时一并处理）

| 源列                               | 处置                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `dg_sendorder.sn` 多运单号         | 见 Q10                                                                                 |
| `dg_fapiao.airbill` varchar(2512)  | 同款多单号（本地最长 139）→ `airbill String? @db.VarChar(64)` + 超长入 legacyExtra     |
| `dg_fapiao.totalweight`            | 含代码值（`A`）→ 字符串列，不转数值                                                    |
| `dg_fapiao.cid`                    | 地址簿 ID（78,344 行=0；14,558 行命中 dg_address.aid）→ `addressBookId Int?`（0→NULL） |
| `dg_fapiao` 53 列                  | 全列映射，快照列（收件人/会员信息）保留并命名 `*Snapshot` 语义                         |
| `v2_sendorder_value_added_service` | 本地 36 行、sid 无空值 → 正常回填（JOIN send_orders 过滤）                             |

## 九、留待后续（不阻塞 schema 落地）

| #   | 问题                                                           | 处置时机                                                                  |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Q4  | state 5/6 写入点未定位全                                       | 新系统迁移表白名单对未核实迁移一律拒（§4.4 已定），生产灰度前补核实       |
| Q8  | `v2_send_order_label` / `v2_send_order_invoice_event` 本地无表 | 回填脚本用 PREPARE 条件执行（本地自动跳过）；生产跑前经跳板机只读确认行数 |
| Q9  | 评价 comment JSON 键位                                         | contract 切片时定；`comment Json` 先原样落库                              |
