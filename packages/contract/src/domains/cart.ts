import { z } from 'zod';

/**
 * cart 契约 —— 购物车读路径（旧 listCart / getCartMoney 1:1）。
 * dg_cart / v2_supplier_product 属主 = order 域（docs/plans/07 §四），service 落 order 域。
 * 金额字符串承载（禁 JS 浮点回传）；时间 ISO 化（Asia/Shanghai）。
 */

/** 加购来源（旧 add_from 注释词表） */
export const CART_ADD_FROM = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11] as const;

/** 供应商商品摘要（旧 CartType.supplierProduct 的 R1 子集：阶梯价/混批判定所需 + 身份字段，S30 登记） */
export const supplierProductSummarySchema = z.object({
  id: z.number().int(),
  shopId: z.number().int().nullable(),
  platform: z.string(),
  goodsId: z.string(),
  goodsName: z.string(),
  /** 1688 阶梯价（JSON 数组 [{startQuantity, price}]；null = 无） */
  priceRange: z.array(z.object({ startQuantity: z.number(), price: z.number() })).nullable(),
  minOrderQuantity: z.number().int(),
  /** 店铺混批规则 JSON（{mixAmount?, mixNumber?}；null = 无） */
  sellerMixSetting: z.object({ mixAmount: z.number().optional(), mixNumber: z.number().optional() }).nullable(),
  onePieceFreePostage: z.boolean(),
});
export type SupplierProductSummary = z.infer<typeof supplierProductSummarySchema>;

/** 购物车行（旧 Member/CartType 输出 1:1；var1..var12 = ①〜⑫検品オプション） */
export const cartRowSchema = z.object({
  gid: z.number().int().positive(),
  uid: z.number().int(),
  uname: z.string().nullable(),
  type: z.number().int(),
  supplierProduct: supplierProductSummarySchema.nullable(),
  goodsName: z.string().nullable(),
  /** 旧 resolveGoodsnameTransField：goods_name_trans ?? goodsname */
  goodsNameTrans: z.string().nullable(),
  goodsUrl: z.string().nullable(),
  goodsImg: z.string().nullable(),
  goodsSeller: z.string().nullable(),
  goodsSite: z.string().nullable(),
  skuName: z.string().nullable(),
  /** 规格（旧 parseSkuName：red/green 标签 + 空值回退尺码/颜色） */
  goodSkus: z.array(z.object({ name: z.string(), value: z.string() })),
  /** 旧 resolveGoodSkuTransField：sku_trans（JSON 数组）否则回退 parseSkuName */
  goodSkuTrans: z.array(z.object({ name: z.string(), value: z.string() })),
  ship: z.number().int().nullable(),
  goodsPrice: z.string(),
  /** 旧 resolveOnePiecePriceField：one_piece_price ?? goodsprice */
  onePiecePrice: z.string(),
  /** 旧 resolveOfferPriceField：offer_price ?? goodsprice */
  offerPrice: z.string(),
  /** 零售价（未设置 = null——0 视为未设置，旧 storedRetailPrice 语义） */
  retailPrice: z.string().nullable(),
  goodsNum: z.number().int(),
  minOrderQuantity: z.number().int(),
  var1: z.string().nullable(),
  var2: z.string().nullable(),
  var3: z.string().nullable(),
  var4: z.string().nullable(),
  var5: z.string().nullable(),
  var6: z.string().nullable(),
  var7: z.string().nullable(),
  var8: z.string().nullable(),
  var9: z.string().nullable(),
  var10: z.string().nullable(),
  var11: z.string().nullable(),
  var12: z.string().nullable(),
  fba: z.string().nullable(),
  asin: z.string().nullable(),
  fnsku: z.string().nullable(),
  outId: z.string().nullable(),
  service: z.string().nullable(),
  sendPrice: z.string(),
  goodsRemark: z.string().nullable(),
  addFrom: z.number().int(),
  expressNo: z.string().nullable(),
  /** 加购时间（ISO；旧回 unix int，REST 面 ISO 化同 order/send-order） */
  createdAt: z.string(),
});
export type CartRow = z.infer<typeof cartRowSchema>;

/** 按卖家分组（旧 CartGroupBySellerType 1:1） */
export const cartGroupSchema = z.object({
  goodsSite: z.string().nullable(),
  goodsSeller: z.string().nullable(),
  carts: z.array(cartRowSchema),
});
export type CartGroup = z.infer<typeof cartGroupSchema>;

/** 购物车列表查询（旧 listCart args：ids 逗号分隔） */
export const cartListQuerySchema = z.object({
  ids: z.string().max(255).optional(),
});
export type CartListQuery = z.infer<typeof cartListQuerySchema>;

/** 购物车金额（旧 CartMoneyType 1:1；金额字符串化，exchangeMoney 保留两位） */
export const cartMoneySchema = z.object({
  goodsMoney: z.string(),
  originalServerMoney: z.string(),
  maxDeductServerMoney: z.string(),
  deductedServerMoney: z.string(),
  serverMoney: z.string(),
  totalMoney: z.string(),
  /** 总计（日元）= totalMoney × 汇率（round2；汇率经端口取） */
  exchangeMoney: z.string(),
});
export type CartMoney = z.infer<typeof cartMoneySchema>;

/** 金额查询入参（旧 getCartMoney args：ids 必填逗号分隔） */
export const cartMoneyQuerySchema = z.object({
  ids: z.string().min(1).max(1024),
});
export type CartMoneyQuery = z.infer<typeof cartMoneyQuerySchema>;
