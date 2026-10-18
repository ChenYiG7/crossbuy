import { z } from 'zod';
import { pageQuerySchema, type PageResult } from '../core';

/**
 * send-order 域契约 —— 唯一对外类型源（docs/07 §2）。
 * 词表正本：状态机/totalfee 口径/发票归属见 docs/plans/send-order-schema.md；
 * Q3（发票归本域）等七条收口见 docs/plans/06-send-order-评审与拍板.md。
 *
 * 纪律：
 *   · 金额一律 Money（字符串）；totalfee 禁信历史值——契约不出 totalfee 快照读值，
 *     只出五费分列 + chargedTotalFee（审计列，仅已邮寄/支付成功后有值）
 *   · 日期一律 ISO 字符串
 *   · importerInfo.real_time_account（报关完整号码）禁出行视图（敏感）；
 *     保存服务层「禁掩码」校验见 send-order-schema.md §4.8
 */

// ---------------------------------------------------------------------------
// 一、词表（schema 注释即拍板表）
// ---------------------------------------------------------------------------

/** 运单 8 态状态机（SendOrder.php 定稿；迁移正本 docs/plans/09 §2） */
export const SendOrderStatus = {
  /** 1 待处理（唯一可取消态） */
  WAITING: 1,
  /** 2 已邮寄（确认已邮寄并返金后进入） */
  SHIPPED: 2,
  /** 3 已完成（确认收货 + 积分同事务） */
  COMPLETED: 3,
  /** 4 无效运单 */
  INVALID: 4,
  /** 5 处理中（admin 打包；客户要求修改发票时 7→5 退回担当，行锁） */
  PROCESSING: 5,
  /** 6 待审核（⚠ 全库无写点——旧遗留值，读得到写不进） */
  PENDING_CHECK: 6,
  /** 7 待付款（admin「发送发票」入口置入；砍价即时返金在此触发） */
  PENDING_PAY: 7,
  /** 8 待邮寄（用户支付运费 7→8） */
  PENDING_SHIP: 8,
} as const;
export type SendOrderStatusCode = (typeof SendOrderStatus)[keyof typeof SendOrderStatus];
export const sendOrderStatusSchema = z.nativeEnum(SendOrderStatus);

/** 可取消态（旧系统核实：仅 1；副作用 = 订单回 4 + sid=0 + 券复原 + 仓储回改） */
export const SEND_ORDER_CANCELABLE_STATUS: SendOrderStatusCode = SendOrderStatus.WAITING;
/** 支付迁移（SendOrderPayService：锁 sendorder → 锁 user → 扣 totalfee → 回写） */
export const SEND_ORDER_PAY_TRANSITION: { from: SendOrderStatusCode; to: SendOrderStatusCode } = {
  from: SendOrderStatus.PENDING_PAY,
  to: SendOrderStatus.PENDING_SHIP,
};

/**
 * 「旧 admin 批量工具无 from 守卫」目标分支的来源全集（S19 弱守卫保真）：
 * dump 实测 state=6 零行（遗留死值无存量）→ 6 不进 from 表。
 * 用户面强守卫路径（付运费 7→8、确认收货 2→3、发票修订 7→5）在 service 层另有
 * 行锁 + 状态校验，这里只是合法矩阵的并集。
 */
const SEND_ORDER_FROM_ANY_ACTIVE: readonly SendOrderStatusCode[] = [
  SendOrderStatus.WAITING,
  SendOrderStatus.SHIPPED,
  SendOrderStatus.COMPLETED,
  SendOrderStatus.INVALID,
  SendOrderStatus.PROCESSING,
  SendOrderStatus.PENDING_PAY,
  SendOrderStatus.PENDING_SHIP,
];

/**
 * 运单状态迁移白名单（键 = 目标态，值 = 允许来源态）——docs/plans/09 §2.1 核实正本。
 * 有强守卫的入口按守卫原文收录（→7/→8）；admin 批量工具无守卫的分支（→2/→3/→4/→5）
 * 按旧真实行为收录为全活跃态——1:1 保真，R2 收敛时收紧（S19）。
 */
export const SEND_ORDER_STATUS_TRANSITIONS: Readonly<
  Record<SendOrderStatusCode, readonly SendOrderStatusCode[]>
> = {
  /** 创建初态；无迁移写点（订单回改联动把运单改回 1 的源态未核实完整，暂拒——见 09 §2.1 A 组） */
  [SendOrderStatus.WAITING]: [],
  /** admin 批量邮寄（DG 无守卫；DF 仅 state≠2 幂等校验）→ 旧真实行为 = 除自身外全活跃态 */
  [SendOrderStatus.SHIPPED]: SEND_ORDER_FROM_ANY_ACTIVE.filter(
    (s) => s !== SendOrderStatus.SHIPPED,
  ),
  /** 用户确认收货（行锁，必须 2，DF 当天发货不可当天确认）；admin 批量完成无守卫 */
  [SendOrderStatus.COMPLETED]: [...SEND_ORDER_FROM_ANY_ACTIVE],
  /** 订单拉无效联动（DF 拆分）/ admin 批量 / 删运单（旧无守卫） */
  [SendOrderStatus.INVALID]: [...SEND_ORDER_FROM_ANY_ACTIVE],
  /** admin 批量打包（旧无守卫）；客户要求修改发票 7→5 退回担当（行锁 + 发票必须已发送） */
  [SendOrderStatus.PROCESSING]: [...SEND_ORDER_FROM_ANY_ACTIVE],
  /** 6 = 待审核：全库无写点、dump 零行（旧遗留死值）——读得到写不进 */
  [SendOrderStatus.PENDING_CHECK]: [],
  /** admin「发送发票」守卫原文：禁 {2,3,4,8}（EditFapiao:1195-1203）→ 允许 1/5/6；6 dump 零行不收录；
   *  砍价即时返金挂在此写点（bargainstate=0 且 bargainprice>0 → ACTION_11） */
  [SendOrderStatus.PENDING_PAY]: [SendOrderStatus.WAITING, SendOrderStatus.PROCESSING],
  /** 用户支付运费（SendOrderPayService：行锁 + 必须 state=7 + 余额≥totalfee） */
  [SendOrderStatus.PENDING_SHIP]: [SendOrderStatus.PENDING_PAY],
};

/** 迁移判定（service 层状态命令的唯一合法入口） */
export function canTransitionSendOrderStatus(
  from: SendOrderStatusCode,
  to: SendOrderStatusCode,
): boolean {
  return SEND_ORDER_STATUS_TRANSITIONS[to].includes(from);
}

/** 作业子状态 0-9（prostate，与 status 并存的两条流，禁混枚举） */
export const ProstateCode = {
  /** 0 无 */
  NONE: 0,
  /** 1 等待同梱 */
  WAIT_BUNDLE: 1,
  /** 2 等 OEM 商品同梱 */
  WAIT_OEM_BUNDLE: 2,
  /** 3 FBA 作业中 */
  FBA_WORKING: 3,
  /** 4 等客户指示 */
  WAIT_CUSTOMER: 4,
  /** 5 打包中 */
  PACKING: 5,
  /** 6 有商品找不到 */
  GOODS_MISSING: 6,
  /** 7 正在做发票 */
  INVOICING: 7,
  /** 8 拍照中 */
  PHOTOING: 8,
  /** 9 缝标中 */
  SEWING_LABEL: 9,
} as const;
export type ProstateCodeValue = (typeof ProstateCode)[keyof typeof ProstateCode];
export const prostateCodeSchema = z.nativeEnum(ProstateCode);

/** 运单类型（旧 otype：实测只有 1/3，无 2） */
export const SendOrderType = {
  /** 1 普通代购 */
  PURCHASE: 1,
  /** 3 一件代发 */
  ONE_PIECE: 3,
} as const;
export type SendOrderTypeCode = (typeof SendOrderType)[keyof typeof SendOrderType];
export const sendOrderTypeSchema = z.nativeEnum(SendOrderType);

/** 贴标规则（旧 madeinchina_flag） */
export const MadeInChinaFlag = {
  /** 0 不贴 */
  NONE: 0,
  /** 1-3 贴标规则（运营配置） */
  RULE_1: 1,
  RULE_2: 2,
  RULE_3: 3,
} as const;
export type MadeInChinaFlagCode = (typeof MadeInChinaFlag)[keyof typeof MadeInChinaFlag];
export const madeInChinaFlagSchema = z.nativeEnum(MadeInChinaFlag);

/** 客户上传标签类型（v2_send_order_label.type） */
export const LabelType = {
  /** FBA 箱标 */
  FBA_BOX: 'fba_box',
  /** FNSKU 商品标 */
  FBA_ITEM: 'fba_item',
  /** 其他 3PL 箱标 */
  THIRD_PL_BOX: '3pl_box',
  /** 运单 */
  CARRIER: 'carrier',
} as const;
export type LabelTypeCode = (typeof LabelType)[keyof typeof LabelType];
export const labelTypeSchema = z.nativeEnum(LabelType);

/** 标签状态（v2_send_order_label.status） */
export const LabelStatus = {
  /** 0 已收到 */
  RECEIVED: 0,
  /** 1 已贴 */
  APPLIED: 1,
  /** 2 已扫描核对 */
  VERIFIED: 2,
} as const;
export type LabelStatusCode = (typeof LabelStatus)[keyof typeof LabelStatus];
export const labelStatusSchema = z.nativeEnum(LabelStatus);

/** 发票事件类型（v2_send_order_invoice_event.type；append-only） */
export const InvoiceEventType = {
  /** 客户要求修改发票 */
  REVISE_REQUESTED: 'revise_requested',
  /** 支付＝确认了这一版发票 */
  PAID_CONFIRMED: 'paid_confirmed',
} as const;
export type InvoiceEventTypeCode = (typeof InvoiceEventType)[keyof typeof InvoiceEventType];
export const invoiceEventTypeSchema = z.nativeEnum(InvoiceEventType);

/**
 * 配送渠道（旧 deliveryname 自由字符串）。
 * ⚠ 禁做严格枚举——运营会加新渠道（本地实测 14 个观察值）；
 *   下面是观察值文档，service 层容错新值。
 */
export const DELIVERY_CHANNEL_OBSERVED = [
  'ヤマト急便',
  '佐川急便',
  'ZC航空便',
  '日本郵政船便',
  'EMS',
  'OCS',
  'TW閩専線',
  'TW閩専線VIP',
  '中国郵政船便VIP',
  '自提',
  'SG国内便',
  '山九急便',
  'EMS航空便',
  '佐川急便飞马',
] as const;
export const deliveryChannelSchema = z.string().max(30);

// ---------------------------------------------------------------------------
// 二、开放 API（支付/取消；错误码见 core.OpenApiCode）
// ---------------------------------------------------------------------------

/**
 * 运单支付入参（POST /send-orders/pay）。
 * captcha 来自 GET /send-orders/pay-captcha（6 位数字，Cache 绑定 uid，TTL 300s，一次性）。
 */
export const paySendOrderSchema = z.object({
  sid: z.number().int().positive(),
  captcha: z.string().regex(/^\d{6}$/),
});
export type PaySendOrderInput = z.infer<typeof paySendOrderSchema>;

/** 运单支付出参 */
export interface PaySendOrderResult {
  sid: number;
}

/** 运单取消入参（POST /send-orders/cancel；仅 STATE_WAITING(1)） */
export const cancelSendOrderSchema = z.object({
  sid: z.number().int().positive(),
});
export type CancelSendOrderInput = z.infer<typeof cancelSendOrderSchema>;

// ---------------------------------------------------------------------------
// 三、只读查询（XxxQuery + XxxRow）
// ---------------------------------------------------------------------------

/** 运单列表查询：分页 + 状态/类型过滤；数据权限（会员轴）service 层强制覆盖 */
export const sendOrderQuerySchema = pageQuerySchema.extend({
  status: z.union([sendOrderStatusSchema, z.array(sendOrderStatusSchema)]).optional(),
  type: sendOrderTypeSchema.optional(),
  createdAtFrom: z.string().datetime().optional(),
  createdAtTo: z.string().datetime().optional(),
});
export type SendOrderQuery = z.infer<typeof sendOrderQuerySchema>;

/**
 * 运单行视图（HTTP 边界出参）。
 * 禁出：importerInfo（报关敏感）；consignee/address 等收件人快照仅详情接口按需出。
 * totalfee 不出读值（禁信历史值）——出五费分列，客户端/服务端现算。
 */
export const sendOrderRowSchema = z.object({
  id: z.number().int().positive(),
  sn: z.string().nullable(),
  memberId: z.number().int().positive(),
  orderType: sendOrderTypeSchema,
  status: sendOrderStatusSchema,
  statusEnteredAt: z.string(),
  prostate: prostateCodeSchema.nullable(),
  /** 五费分列（Money）——totalfee 由服务端 calculateTotalFee() 现算 */
  internationalFreight: z.string(),
  serviceFee: z.string(),
  customsFee: z.string(),
  remoteFee: z.string(),
  domesticShippingFee: z.string(),
  insuranceFee: z.string(),
  /** 实扣总费快照（审计列；仅已邮寄/支付成功后有值，禁作业务读值） */
  chargedTotalFee: z.string().nullable(),
  bargainAmount: z.string(),
  bargainRefunded: z.boolean(),
  deliveryChannel: z.string().nullable(),
  totalPackages: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SendOrderRow = z.infer<typeof sendOrderRowSchema>;

/** 运单分页出参（list 永不为 null，core 约定） */
export type SendOrderPageResult = PageResult<SendOrderRow>;

/**
 * 运单详情行视图（会员本人查询；收件人快照是历史事实）。
 * importerInfo 仍禁出——报关号码仅仓储/清关内部面经 wms-gateway 流转。
 */
export const sendOrderDetailRowSchema = sendOrderRowSchema.extend({
  consignee: z.string().nullable(),
  enName: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  tel: z.string().nullable(),
  address: z.string().nullable(),
  companyName: z.string().nullable(),
  invoiceDelivered: z.boolean(),
  invoiceDeliveredAt: z.string().nullable(),
  dfTrackingNo: z.string().nullable(),
  mailRemark: z.string().nullable(),
});
export type SendOrderDetailRow = z.infer<typeof sendOrderDetailRowSchema>;

// ---------------------------------------------------------------------------
// 四、侧表行视图
// ---------------------------------------------------------------------------

/** 客户上传标签行视图（文件只出 path，禁 base64） */
export const sendOrderLabelRowSchema = z.object({
  id: z.string(),
  sendOrderId: z.number().int().positive(),
  type: labelTypeSchema,
  status: labelStatusSchema,
  filePath: z.string(),
  fileName: z.string(),
  mime: z.string(),
  size: z.number().int(),
  fbaShipmentId: z.string().nullable(),
  destinationCode: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type SendOrderLabelRow = z.infer<typeof sendOrderLabelRowSchema>;

/** 客户上传标签入参（文件先经 OSS 直传得到 path，禁 base64 过契约） */
export const sendOrderLabelCreateSchema = z.object({
  sendOrderId: z.number().int().positive(),
  type: labelTypeSchema,
  filePath: z.string().min(1).max(255),
  fileName: z.string().min(1).max(191),
  mime: z.string().max(32),
  size: z.number().int().min(0),
  fbaShipmentId: z.string().max(64).optional(),
  destinationCode: z.string().max(32).optional(),
  boxes: z
    .array(
      z.object({
        boxNo: z.string(),
        orderId: z.number().int().positive().optional(),
        qty: z.number().int().min(1),
      }),
    )
    .optional(),
});
export type SendOrderLabelCreate = z.infer<typeof sendOrderLabelCreateSchema>;

/** 发票事件行视图（append-only） */
export const sendOrderInvoiceEventRowSchema = z.object({
  id: z.string(),
  sendOrderId: z.number().int().positive(),
  type: invoiceEventTypeSchema,
  invoiceVersion: z.string(),
  comment: z.string().nullable(),
  source: z.string(),
  ticketId: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type SendOrderInvoiceEventRow = z.infer<typeof sendOrderInvoiceEventRowSchema>;

/**
 * 发票修订请求入参（开放接口；invoiceVersion 是锁内校验的关键——
 * service 层在锁内比对当前版本，防并发双改）。
 */
export const invoiceReviseRequestSchema = z.object({
  sendOrderId: z.number().int().positive(),
  invoiceVersion: z.string().min(1).max(32),
  comment: z.string().max(2000),
  imagePaths: z.array(z.string().max(255)).max(9).optional(),
});
export type InvoiceReviseRequest = z.infer<typeof invoiceReviseRequestSchema>;

/** 运单增值服务收费行视图 */
export const sendOrderValueAddedServiceRowSchema = z.object({
  id: z.number().int().positive(),
  sendOrderId: z.number().int().positive(),
  serviceId: z.number().int().positive(),
  nameSnapshot: z.string(),
  fee: z.string(),
  isManual: z.boolean(),
});
export type SendOrderValueAddedServiceRow = z.infer<typeof sendOrderValueAddedServiceRowSchema>;

// ---------------------------------------------------------------------------
// 五、写侧命令（内部管理面）
// ---------------------------------------------------------------------------

/**
 * 运单保存命令（importerInfo 的 real_time_account 禁掩码——
 * service 层检出掩码时按地址簿补回、对不上拒绝，§4.8）。
 */
export const sendOrderSaveSchema = z.object({
  consignee: z.string().min(1).max(30),
  enName: z.string().max(30).nullable().optional(),
  country: z.string().max(30).nullable().optional(),
  city: z.string().max(30).nullable().optional(),
  zip: z.string().max(30).nullable().optional(),
  tel: z.string().max(30).nullable().optional(),
  address: z.string().max(255).nullable().optional(),
  companyName: z.string().max(100).nullable().optional(),
  deliveryChannel: deliveryChannelSchema.nullable().optional(),
  /** 进口商信息 JSON（键契约化：aid/real_time_account/...；禁掩码） */
  importerInfo: z.record(z.unknown()).nullable().optional(),
  mailRemark: z.string().max(1024).nullable().optional(),
});
export type SendOrderSave = z.infer<typeof sendOrderSaveSchema>;

/**
 * 运单状态迁移命令（集中式迁移表白名单，§4.4）。
 * 合法性按 `SEND_ORDER_STATUS_TRANSITIONS`（docs/plans/09 §2.1 核实正本）判定，
 * service 层用 `canTransitionSendOrderStatus` 拒绝表外迁移；
 * 资金动作写点对齐：→2（DF 批量邮寄 = 扣运费 + action=11 返金）、7→8（付运费）、
 * →7（发送发票 = 砍价即时返金）——返金幂等 = action=11 流水 remark 反查（S14 同族）。
 */
export const sendOrderStatusChangeSchema = z.object({
  sendOrderId: z.number().int().positive(),
  toStatus: sendOrderStatusSchema,
  operatorType: z.enum(['member', 'admin', 'system', 'worker']),
  operatorId: z.number().int().positive().nullable().optional(),
  reason: z.string().max(255).nullable().optional(),
});
export type SendOrderStatusChange = z.infer<typeof sendOrderStatusChangeSchema>;

/** prostate 作业流变更命令（与 state 分离的第二条流） */
export const prostateChangeSchema = z.object({
  sendOrderId: z.number().int().positive(),
  toProstate: prostateCodeSchema,
  operatorType: z.enum(['admin', 'system', 'worker']),
  operatorId: z.number().int().positive().nullable().optional(),
});
export type ProstateChange = z.infer<typeof prostateChangeSchema>;

// ---------------------------------------------------------------------------
// 五、R1 复现期：会员运单列表（旧 listSendOrder + SendOrderListInput 1:1）
// ---------------------------------------------------------------------------

/** 运单列表查询（旧 SendOrderListInput::fields 1:1——**storeMode 死条件不入契约**：buildQuery 引用了未声明的字段，GraphQL 永不传入，S28 登记） */
export const sendOrderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sid: z.coerce.number().int().optional(),
  state: sendOrderStatusSchema.optional(),
  /** 关键字：`数字/数字` 形态走 sid 精确路径；否则 LIKE sid/oids/address/sn/consignee */
  keyword: z.string().max(255).optional(),
  /** 订单关键字：oid/goodsname/outid/yanhuofnsku/goodsremark/yanhuoasin（经订单侧反查 sid） */
  orderKeyword: z.string().max(255).optional(),
  /** 时间窗过滤的是 **uptime**（非 addtime——1:1） */
  startTime: z.coerce.number().int().optional(),
  endTime: z.coerce.number().int().optional(),
});
export type SendOrderListQuery = z.infer<typeof sendOrderListQuerySchema>;

/** 国际物流信息（旧 Airbill type 子集；空时按 sn '#' 拆分合成——resolveAirbillsField 1:1） */
export const airbillSchema = z.object({
  sendid: z.number().int(),
  sn: z.string().nullable(),
  traceInfo: z.string().nullable(),
});
export type Airbill = z.infer<typeof airbillSchema>;

/** 收货地址信息（旧 resolveAddressInfoField 1:1） */
export const sendOrderAddressInfoSchema = z.object({
  consignee: z.string().nullable(),
  enname: z.string().nullable(),
  companyName: z.string().nullable(),
  country: z.string().nullable(),
  address: z.string().nullable(),
  tel: z.string().nullable(),
  zip: z.string().nullable(),
});

/** 运单行（旧 Member/SendOrderType 输出 1:1 主行；金额 Money 字符串化、时间 ISO 化同 order 面） */
export const sendOrderMemberRowSchema = z.object({
  sid: z.number().int(),
  uid: z.number().int(),
  /** 订单 ids CSV（旧原样字符串列） */
  oids: z.string().nullable(),
  consignee: z.string().nullable(),
  address: z.string().nullable(),
  tel: z.string().nullable(),
  zip: z.string().nullable(),
  /** 配送方法（deliveryname） */
  deliveryName: z.string().nullable(),
  /** 追踪号（多单号 '#' 分隔） */
  sn: z.string().nullable(),
  countWeight: z.string().nullable(),
  /** 代发商品规格 长宽高#分隔（dflwh） */
  dfSpec: z.string().nullable(),
  state: sendOrderStatusSchema,
  freight: z.string(),
  serverFee: z.string(),
  customsFee: z.string(),
  /** 国内运费（列值原样） */
  sendPrice: z.string(),
  /** 合计费用（旧 calculateTotalfee：round2 四项 + 国内运费兜底汇总） */
  totalSendFee: z.string(),
  /** 评价（comment 列是 JSON：{comment: string}——resolveCommentField 1:1） */
  comment: z.string(),
  commentAt: z.number().int().nullable(),
  reply: z.string().nullable(),
  remark: z.string().nullable(),
  haveInvoice: z.boolean(),
  /** 任一订单 yanhuofba='FBA'（resolveFBAField；订单经端口读） */
  fba: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 物流查询网址（SystemSetting 端口；缺省 '' / Google 搜索兜底在端口内） */
  shippingWebsiteUrl: z.string(),
  /** 进口商信息（列原样 JSON 字符串——旧 GraphQL alias 到 Address 类型属遗留坏味道，R1 原样透出，S28） */
  importerInfo: z.string().nullable(),
  addressInfo: sendOrderAddressInfoSchema,
  /** 到货标记：首订单 mark_flag arrival 位非 0（resolveArrivalField 1:1；无订单 = 0） */
  arrival: z.union([z.literal(0), z.literal(1)]),
  airbills: z.array(airbillSchema),
  dfsendname: z.string().nullable(),
  dfsendaddress: z.string().nullable(),
  dfsendtel: z.string().nullable(),
  originPackageChoice: z.number().int().nullable(),
});
export type SendOrderMemberRow = z.infer<typeof sendOrderMemberRowSchema>;

/** 列表出参（⚠ 旧 GraphQL 面**不回 total**（CustomPaginationType data/page/size）——1:1 不回，S29；REST 需要时按需补 count） */
export type SendOrderMemberPageResult = {
  rows: SendOrderMemberRow[];
  page: number;
  pageSize: number;
};
