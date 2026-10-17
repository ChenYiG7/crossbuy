import { z } from 'zod';
import { pageQuerySchema, type Money, type PageResult } from '../core';

/**
 * order 域契约 —— 唯一对外类型源（docs/07 §2：契约物理隔离，禁 import ORM/框架类型）。
 * 词表正本：状态机与金额口径见 docs/plans/order-schema.md（Q5 已拍板）。
 *
 * 纪律：
 *   · 金额一律 Money（字符串，服务端重算，禁浮点）
 *   · 日期一律 ISO 字符串（行视图出参）
 *   · 状态列用 Int 字面量枚举 + 中文/日文注释（三方对齐：schema ↔ 设计文档 ↔ 本文件）
 *   · 行视图禁出敏感字段（importerInfo/real_time_account 归 send-order 域且禁出）
 */

// ---------------------------------------------------------------------------
// 一、词表（schema 注释即拍板表）
// ---------------------------------------------------------------------------

/** 订单 12 态状态机（Order.php 定稿；无效三态不参与金额计算，10/11 为终态） */
export const OrderStatus = {
  /** 1 采购中（唯一可取消态之一，与 6） */
  WAIT_CREATE: 1,
  /** 2 已采购 */
  PAID: 2,
  /** 3 从商店发货完成（在途；库存拆分允许的源态） */
  SEND: 3,
  /** 4 到达本公司仓库（提交运单的唯一入口态） */
  ARRIVE_CHINA: 4,
  /** 5 发送请求提交完毕（取消运单回 4） */
  DELIVERY: 5,
  /** 6 无效订单（未返金；可取消态；不参与金额计算） */
  INVALID: 6,
  /** 7 增值检品中（库存拆分允许的源态） */
  CHECKING: 7,
  /** 8 航空禁运品 */
  FORBIDDEN_AIRLINE: 8,
  /** 9 不良对应（售后）中（进入即给 expressno 加 _S 后缀） */
  AFTER_SALE: 9,
  /** 10 无效订单（已返金；最终态） */
  INVALID_REFUNDED: 10,
  /** 11 无效订单（已废弃；最终态） */
  INVALID_DISUSED: 11,
  /** 12 不良对应（售后）待确认（同 9 加 _S） */
  AFTER_SALE_WAIT_CHECK: 12,
} as const;
export type OrderStatusCode = (typeof OrderStatus)[keyof typeof OrderStatus];
export const orderStatusSchema = z.nativeEnum(OrderStatus);

/** 金额计算一律排除的无效态（旧 $invalidStates） */
export const ORDER_INVALID_STATUSES: readonly OrderStatusCode[] = [
  OrderStatus.INVALID,
  OrderStatus.INVALID_REFUNDED,
  OrderStatus.INVALID_DISUSED,
];
/** 终态（禁再迁移） */
export const ORDER_FINAL_STATUSES: readonly OrderStatusCode[] = [
  OrderStatus.INVALID_REFUNDED,
  OrderStatus.INVALID_DISUSED,
];
/** 可取消态（旧系统核实：仅 1/6） */
export const ORDER_CANCELABLE_STATUSES: readonly OrderStatusCode[] = [
  OrderStatus.WAIT_CREATE,
  OrderStatus.INVALID,
];
/** 提交运单的唯一入口态 */
export const ORDER_SUBMIT_SEND_STATUS: OrderStatusCode = OrderStatus.ARRIVE_CHINA;

/**
 * 「旧代码无 from 白名单」目标分支的来源全集：全局守卫仅禁终态 [10,11]
 * （BatchUpdateOrder:250），dump 实测 state=8 零行（S17 死状态无存量）→ 8 不进 from 表。
 * 各目标仍有**分支附加守卫**（→4 需 expressno、→6/→11 增值售后单 sendprice>0 禁止等），
 * 附加守卫在 service 层落，不占迁移表。
 */
const ORDER_FROM_ANY_ACTIVE: readonly OrderStatusCode[] = [
  OrderStatus.WAIT_CREATE,
  OrderStatus.PAID,
  OrderStatus.SEND,
  OrderStatus.ARRIVE_CHINA,
  OrderStatus.DELIVERY,
  OrderStatus.INVALID,
  OrderStatus.CHECKING,
  OrderStatus.AFTER_SALE,
  OrderStatus.AFTER_SALE_WAIT_CHECK,
];

/**
 * 订单状态迁移白名单（集中式迁移表，§4.4）——**键 = 目标态，值 = 允许的来源态**。
 *
 * 正本：docs/plans/09-交易链路状态机.md §1.1（2026-10-17 旧代码 85 处写点全量核实，
 * from 守卫逐分支对过 BatchUpdateOrder.php 源码）。有 from 白名单的分支按白名单原文
 * 收录（→1/→2/→5/→9/→12/→10）；无白名单的分支（→3/→4/→6/→7/→11）按旧真实守卫
 * （仅禁终态）收录为全活跃态——这是 **1:1 保真**不是放宽；R2 收敛时再收紧（S19）。
 */
export const ORDER_STATUS_TRANSITIONS: Readonly<Record<OrderStatusCode, readonly OrderStatusCode[]>> = {
  /** 回改重新下单：6→1（BatchUpdateOrder:436 白名单仅 6，PAID 被注释）；2/9→1（BatchUpdateOrderState:92） */
  [OrderStatus.WAIT_CREATE]: [OrderStatus.PAID, OrderStatus.INVALID, OrderStatus.AFTER_SALE],
  /** 1→2（1688 支付 webhook / admin 手动确认，白名单仅 1）；3/9→2（BatchUpdateOrderState:98 回改） */
  [OrderStatus.PAID]: [OrderStatus.WAIT_CREATE, OrderStatus.SEND, OrderStatus.AFTER_SALE],
  /** webhook 发货仅 2→3；admin 批量编辑分支无 from 校验（仅写 waytime）→ 旧真实守卫 = 仅禁终态 */
  [OrderStatus.SEND]: [...ORDER_FROM_ANY_ACTIVE],
  /** admin 入库分支无 from 白名单（需全单 expressno + 禁终态）；5→4 取消运单回退同经此表 */
  [OrderStatus.ARRIVE_CHINA]: [...ORDER_FROM_ANY_ACTIVE],
  /** 4→5 用户提交配送（行锁）；admin 白名单原文 [3,4,7,9,12,5]（BatchUpdateOrder:462-469，含 5 自环） */
  [OrderStatus.DELIVERY]: [
    OrderStatus.SEND,
    OrderStatus.ARRIVE_CHINA,
    OrderStatus.DELIVERY,
    OrderStatus.CHECKING,
    OrderStatus.AFTER_SALE,
    OrderStatus.AFTER_SALE_WAIT_CHECK,
  ],
  /** 拉无效分支无 from 白名单（检品员禁 + 增值/售后单 sendprice>0 禁）；9→6 售后处理流含在全集 */
  [OrderStatus.INVALID]: [...ORDER_FROM_ANY_ACTIVE],
  /** 增值检品分支无 from 白名单（仅写 incretime） */
  [OrderStatus.CHECKING]: [...ORDER_FROM_ANY_ACTIVE],
  /** 8 = 死状态（S17）：全库零写点、dump 零行——读得到写不进，任何迁移都不允许进 8 */
  [OrderStatus.FORBIDDEN_AIRLINE]: [],
  /** admin 白名单原文 [2,3,4,7,5,12]（:512-519）+ 12→9 确认售后（ConfirmAfterSalesForm 必须 from=12） */
  [OrderStatus.AFTER_SALE]: [
    OrderStatus.PAID,
    OrderStatus.SEND,
    OrderStatus.ARRIVE_CHINA,
    OrderStatus.DELIVERY,
    OrderStatus.CHECKING,
    OrderStatus.AFTER_SALE_WAIT_CHECK,
  ],
  /** **10 唯一入口 = 用户本人取消订单**（1/6→10，OrderCancelService 行锁 + 返金）；admin 无直写 10 的路径 */
  [OrderStatus.INVALID_REFUNDED]: [OrderStatus.WAIT_CREATE, OrderStatus.INVALID],
  /** admin 废弃分支无 from 白名单（专用权限 + 增值/售后 sendprice>0 禁）；**6→11 允许**（代码核实） */
  [OrderStatus.INVALID_DISUSED]: [...ORDER_FROM_ANY_ACTIVE],
  /** admin 白名单原文 [2,3,4,7,5]（:489-495 + 同单号级联）+ BatchSetAfterSales 9→12 打回（须有检品记录） */
  [OrderStatus.AFTER_SALE_WAIT_CHECK]: [
    OrderStatus.PAID,
    OrderStatus.SEND,
    OrderStatus.ARRIVE_CHINA,
    OrderStatus.DELIVERY,
    OrderStatus.CHECKING,
    OrderStatus.AFTER_SALE,
  ],
};

/** 迁移判定（service 层状态命令的唯一合法入口，§4.4） */
export function canTransitionOrderStatus(from: OrderStatusCode, to: OrderStatusCode): boolean {
  return ORDER_STATUS_TRANSITIONS[to].includes(from);
}

/** 订单类型（旧 type 列：1 代购 / 2 转运 / 3 一件代发） */
export const OrderType = {
  /** 1 代购 */
  PURCHASE: 1,
  /** 2 转运 */
  TRANSFER: 2,
  /** 3 一件代发 */
  ONE_PIECE: 3,
} as const;
export type OrderTypeCode = (typeof OrderType)[keyof typeof OrderType];
export const orderTypeSchema = z.nativeEnum(OrderType);

/** 下单来源（旧 add_from：2 plugin / 8 api / 其余 web） */
export const OrderSource = {
  WEB: 'web',
  PLUGIN: 'plugin',
  API: 'api',
} as const;
export type OrderSourceCode = (typeof OrderSource)[keyof typeof OrderSource];
export const orderSourceSchema = z.nativeEnum(OrderSource);

/** 建单方式（旧 purchase_type：1 manual / 2 auto / 其余 one_click） */
export const CreationMode = {
  MANUAL: 'manual',
  AUTO: 'auto',
  ONE_CLICK: 'one_click',
} as const;
export type CreationModeCode = (typeof CreationMode)[keyof typeof CreationMode];
export const creationModeSchema = z.nativeEnum(CreationMode);

/** 商品平台（开放 API goods_list.platform） */
export const OrderPlatform = {
  TAOBAO: 'taobao',
  PLATFORM_1688: '1688',
  TRANSSHIPMENT: 'transshipment',
} as const;
export type OrderPlatformCode = (typeof OrderPlatform)[keyof typeof OrderPlatform];
export const orderPlatformSchema = z.nativeEnum(OrderPlatform);

// ---------------------------------------------------------------------------
// 二、开放 API（契约归 member 域开放接口，业务在 order 域；错误码见 core.OpenApiCode）
// ---------------------------------------------------------------------------

/** 开放 API 商品项（POST /orders 的 goods_list 元素） */
export const openApiGoodsItemSchema = z.object({
  platform: orderPlatformSchema,
  title: z.string().min(1).max(200),
  /** 商品库 ID（goods/detail 返回的 product_id） */
  productId: z.number().int().positive().optional(),
  /** 平台 SKU ID */
  skuId: z.string().max(64).optional(),
  url: z.string().url(),
  quantity: z.number().int().min(1),
  /** 店铺昵称；缺省时服务端按平台补全 */
  shopNick: z.string().max(100).nullable().optional(),
  /** 商品图；缺省时服务端按平台补全 */
  img: z.string().url().nullable().optional(),
  /** 售价——服务端按平台实价覆盖，禁信客户端值 */
  price: z.string().nullable().optional(),
  /** 一件代发价——服务端按平台实价覆盖 */
  onePiecePrice: z.string().nullable().optional(),
  /** 供货价——服务端按平台实价覆盖 */
  offerPrice: z.string().nullable().optional(),
  /** 1688 一件零售价——服务端按平台 SKU 实价覆盖，未设置为 null 不转 0 */
  retailPrice: z.string().nullable().optional(),
  /** 是否一件包邮 */
  onePieceFreePostage: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
  /** 价格区间（字符串透传） */
  priceRange: z.string().max(100).nullable().optional(),
  /** 混批设置（字符串透传） */
  sellerMixSetting: z.string().max(255).nullable().optional(),
  /** 规格；缺省时服务端补全 */
  props: z
    .array(z.object({ name: z.string().nullable().optional(), value: z.string().nullable().optional() }))
    .nullable()
    .optional(),
  /** 最低起订量——按同一商品全部 SKU 合计校验，不是单个 SKU */
  minOrderQuantity: z.number().int().min(0).nullable().optional(),
  /** 国内运费（Money） */
  sendPrice: z.string().nullable().optional(),
  remark: z.string().max(500).nullable().optional(),
  /** 物流单号（转运常用） */
  expressNo: z.string().max(64).nullable().optional(),
  /** FBA 勾选。只有 true 写入 FBA；false/缺省为未勾选（旧 "1"/"1" 之外一律未勾选） */
  fba: z.boolean().nullable().optional(),
});

/** 开放 API 建单入参（POST /orders；旧系统上限 20 条临时防护保留） */
export const openApiCreateOrderSchema = z.object({
  goodsList: z.array(openApiGoodsItemSchema).min(1).max(20),
});
export type OpenApiCreateOrderInput = z.infer<typeof openApiCreateOrderSchema>;

/** 开放 API 建单出参（非分页结构；order_ids 多商品时含多个 oid） */
export interface OpenApiCreateOrderResult {
  orderIds: number[];
  /** 本单扣款总额（Money，服务端重算） */
  totalMoney: Money;
}

/**
 * 开放 API 取消入参（POST /orders/cancel）。
 * orderIds 支持逗号分隔字符串或整型数组（旧接口兼容形态），
 * 服务端归一化为正整数去重后校验：仅允许 1/6 态。
 */
export const openApiCancelOrderSchema = z.object({
  orderIds: z.union([z.string().min(1), z.array(z.number().int().positive()).min(1)]),
});
export type OpenApiCancelOrderInput = z.infer<typeof openApiCancelOrderSchema>;

// ---------------------------------------------------------------------------
// 三、只读查询（XxxQuery + XxxRow）
// ---------------------------------------------------------------------------

/** 订单列表查询：分页 + 状态/类型过滤；数据权限（会员轴）由 service 层强制覆盖，禁信调用方 */
export const orderQuerySchema = pageQuerySchema.extend({
  status: z.union([orderStatusSchema, z.array(orderStatusSchema)]).optional(),
  type: orderTypeSchema.optional(),
  /** 按下单时间过滤（ISO 字符串） */
  createdAtFrom: z.string().datetime().optional(),
  createdAtTo: z.string().datetime().optional(),
});
export type OrderQuery = z.infer<typeof orderQuerySchema>;

/**
 * 订单行视图（HTTP 边界出参）。
 * 禁出：extendExtra 原始 JSON（内部字段，服务端按需投影为结构化出参）。
 * 金额字段为 Money 字符串；statusEnteredAt 为当前态进入时间。
 */
export const orderRowSchema = z.object({
  id: z.number().int().positive(),
  groupId: z.number().int().positive(),
  memberId: z.number().int().positive(),
  type: orderTypeSchema,
  status: orderStatusSchema,
  statusEnteredAt: z.string(),
  source: orderSourceSchema,
  creationMode: creationModeSchema,
  goodsId: z.string().nullable(),
  goodsUrl: z.string().nullable(),
  goodsName: z.string().nullable(),
  goodsImg: z.string().nullable(),
  skuName: z.string().nullable(),
  quantity: z.number().int(),
  unitPrice: z.string(),
  bargainedUnitPrice: z.string(),
  shippingFee: z.string(),
  /** 服务费抵减（从 extend 显式化；Q9 第一步） */
  serviceFeeOffset: z.string(),
  sendOrderId: z.number().int().positive().nullable(),
  domesticTrackingNo: z.string().nullable(),
  reissueNo: z.string().nullable(),
  reissueSeq: z.number().int().nullable(),
  isAfterSale: z.boolean(),
  isFavorite: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrderRow = z.infer<typeof orderRowSchema>;

/** 订单分页出参（list 永不为 null，core 约定） */
export type OrderPageResult = PageResult<OrderRow>;

// ---------------------------------------------------------------------------
// 四、写侧命令（内部管理面；开放 API 建单走上面的 openApiCreateOrderSchema）
// ---------------------------------------------------------------------------

/** 后台建单/改单命令：金额字段一律 Money，服务端重算后落库（禁信客户端） */
export const orderCreateSchema = z.object({
  memberId: z.number().int().positive(),
  type: orderTypeSchema,
  goodsId: z.string().max(64).optional(),
  goodsUrl: z.string().url().optional(),
  goodsName: z.string().min(1).max(200),
  skuName: z.string().max(200).nullable().optional(),
  quantity: z.number().int().min(1),
  unitPrice: z.string(),
  shippingFee: z.string().optional(),
  remark: z.string().max(500).nullable().optional(),
});
export type OrderCreate = z.infer<typeof orderCreateSchema>;

export const orderUpdateSchema = orderCreateSchema.partial();
export type OrderUpdate = z.infer<typeof orderUpdateSchema>;

/**
 * 订单状态迁移命令（集中式迁移表白名单，§4.4）。
 * 迁移合法性按本文件 `ORDER_STATUS_TRANSITIONS`（docs/plans/09 §1.1 全量核实正本）判定，
 * service 层用 `canTransitionOrderStatus` 拒绝表外迁移；
 * ⚠ →5/→6/→7 等旧系统无 from 白名单的 admin 面，收紧见白名单注释——
 *   灰度期双跑 diff 打出合法被拒路径时按核实结果补表放行，禁凭感觉扩表。
 */
export const orderStatusChangeSchema = z.object({
  orderId: z.number().int().positive(),
  toStatus: orderStatusSchema,
  operatorType: z.enum(['member', 'admin', 'system', 'worker']),
  operatorId: z.number().int().positive().nullable().optional(),
  reason: z.string().max(255).nullable().optional(),
});
export type OrderStatusChange = z.infer<typeof orderStatusChangeSchema>;

// ---------------------------------------------------------------------------
// 五、R1 复现期：会员订单列表（旧 listOrderV2 + OrderListInput 20 项筛选 1:1）
// ---------------------------------------------------------------------------

/** 「安くなった額」展示状态（旧 OrderBargain::of，docs/plans/09 §3.2 语义） */
export const BargainDisplayStatus = {
  /** display_from 以前下单（画面显示「—」） */
  BEFORE_START: 'before_start',
  /** 无效订单（不显示） */
  INVALID: 'invalid',
  /** 采购中且尚无砍后单价（画面显示「買付後に表示」） */
  PENDING: 'pending',
  /** 已采购未降价 */
  NONE: 'none',
  /** 有降价 */
  SAVED: 'saved',
} as const;
export type BargainDisplayStatusCode = (typeof BargainDisplayStatus)[keyof typeof BargainDisplayStatus];

/** mark_flag 位标记值（旧 MARK_FLAG_VALUE_*：两位一个标记，favorite 占 0-1 位、arrival 占 2-3 位） */
export const MarkFlagValue = {
  DEFAULT: 0,
  SUCCESS: 1,
  PROCESSING: 2,
  FAILED: 3,
} as const;

/** queryType 特殊视图（旧 OrderListInput：refuse 禁运品 / question 站内信问询） */
export const ORDER_LIST_QUERY_TYPES = ['refuse', 'question'] as const;

/**
 * 订单列表查询（旧 OrderListInput::fields 1:1；可选项缺省 = 不过滤）。
 * ⚠ 语义要点（正本 docs/plans/09 §3.1）：
 *  - state=3 时旧代码自动并入 12（不良待确认对客户显示为在途）——service 层落
 *  - dfflag 用户强制 type=3；普通用户强制 type in [1,2]——service 层按 principal 落
 *  - keyword 空格分词最多 3 个（超出报错）；`数字/数字` 形态走 oid 精确路径
 */
export const orderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  expressNo: z.string().max(64).optional(),
  state: orderStatusSchema.optional(),
  states: z.string().max(64).optional(), // 逗号分隔，service 解析校验
  queryType: z.enum(ORDER_LIST_QUERY_TYPES).optional(),
  keyword: z.string().max(255).optional(),
  fnsku: z.string().max(64).optional(),
  startTime: z.coerce.number().int().optional(),
  endTime: z.coerce.number().int().optional(),
  splitId: z.coerce.number().int().optional(),
  sid: z.coerce.number().int().optional(),
  storeMode: z.coerce.number().int().optional(),
  storeState: z.coerce.number().int().optional(),
  inEcommerceSkuIds: z.string().max(255).optional(),
  notInEcommerceSkuIds: z.string().max(255).optional(),
  outId: z.string().max(64).optional(),
  markFavorite: z.union([z.literal(0), z.literal(1)]).optional(),
  markArrival: z.union([z.literal(0), z.literal(1)]).optional(),
  sellerId: z.coerce.number().int().optional(),
  productId: z.coerce.number().int().optional(),
  updatedAfter: z.coerce.number().int().optional(),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

/**
 * 列表行（旧 Member/OrderType 输出字段 1:1 主行部分）。
 * ⚠ 关联视图差异（有意分期，非遗漏）：sendOrder / examinations / arrival /
 * instantChat* / fromSplitOid 依赖 send-order、检品、入库、站内信各属主域，
 * R1 起步子集不返回——前端切流前按需补齐并登记 docs/plans/08。
 */
export const memberOrderRowSchema = z.object({
  oid: z.number().int().positive(),
  sid: z.string().nullable(), // dg_order.sid 是字符串列（S20 双口径；运单主键是 Int）
  type: orderTypeSchema,
  /** **显示态**：12 对客户显示为 3（旧 resolveStateField）——与库内 state 不同 */
  state: orderStatusSchema,
  expressNo: z.string().nullable(),
  goodsId: z.string().nullable(),
  goodsName: z.string().nullable(),
  /** 旧 resolveGoodsNameTransField：detail.goods_name_trans ?? goodsname */
  goodsNameTrans: z.string().nullable(),
  goodsUrl: z.string().nullable(),
  goodsImg: z.string().nullable(),
  goodsSize: z.string().nullable(),
  goodsColor: z.string().nullable(),
  goodsSeller: z.string().nullable(),
  goodsSite: z.string().nullable(),
  /** 商品规格键值对（旧 parseSkuName：sku_name red/green 标签解析，空则回退 size/color） */
  goodSkus: z.array(z.object({ name: z.string(), value: z.string() })),
  /** 旧 resolveGoodSkuTransField：detail.sku_trans（数组）否则回退 parseSkuName */
  goodSkuTrans: z.array(z.object({ name: z.string(), value: z.string() })),
  skuId: z.string().nullable(),
  /** 运送方式 1 エアー便 / 2 船便 / 3 空港禁輸品 */
  ship: z.number().int().nullable(),
  /** 商品单价（Money 字符串；旧 GraphQL float → REST 面修正） */
  goodsPrice: z.string(),
  /** 砍后单价（0 = 无改价记录） */
  goodsPrice1: z.string(),
  bargainStatus: z.enum([BargainDisplayStatus.BEFORE_START, BargainDisplayStatus.INVALID, BargainDisplayStatus.PENDING, BargainDisplayStatus.NONE, BargainDisplayStatus.SAVED]),
  /** (goodsprice − goodsprice1) × goodsnum；before_start/invalid/pending 为 null */
  bargainAmount: z.string().nullable(),
  goodsNum: z.number().int(),
  /** 航空禁运原因（去除 MADE_IN_CHINA 词后剩余） */
  itemLocation: z.string().nullable(),
  /** 中国制造标记（只保留 MADE_IN_CHINA 词） */
  madeInChina: z.string().nullable(),
  sendPrice: z.string(),
  goodsRemark: z.string().nullable(),
  orderRemark: z.string().nullable(),
  fba: z.string().nullable(),
  asin: z.string().nullable(),
  fnsku: z.string().nullable(),
  outId: z.string().nullable(),
  tid: z.string().nullable(),
  /** 下单时间（ISO，Asia/Shanghai；旧回 unix int，REST 面 ISO 化同 favorite） */
  createdAt: z.string(),
  arrivedAt: z.string().nullable(),
  /** 0 直发 / 1 库存（一件代发） */
  dfStoreMode: z.number().int(),
  /** 收藏/到货标记（mark_flag 位解析） */
  markFavorite: z.number().int(),
  markArrival: z.number().int(),
  /** 电商平台订单号（extend.platform_order_no） */
  platformOrderNo: z.string(),
});
export type MemberOrderRow = z.infer<typeof memberOrderRowSchema>;

/** 列表分页出参（Laravel paginate 同构：total 全量计数） */
export type MemberOrderPageResult = PageResult<MemberOrderRow>;
