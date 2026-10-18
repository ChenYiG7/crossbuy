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

/**
 * 供应商商品**只读子集**（旧 CartType.supplierProduct 的 DB 列；跨域经 SupplierCatalogPort 暴露）。
 * 与 SupplierProductSummary（契约输出，camelCase）区分：本类型是域间数据搬运的**原始列形状**
 * （snake_case），避免 order 域价格计算改动（S30 阶梯价/混批逻辑直接读 shop_id/price_range 等）。
 * v2_supplier_product 属主 = purchase 域（docs/plans/07 §四）。
 */
export interface SupplierProductRead {
  id: number;
  shop_id: number | null;
  platform: string;
  goods_id: string;
  goods_name: string;
  /** 阶梯价 JSON（[{startQuantity, price}] 或 null） */
  price_range: unknown;
  min_order_quantity: number;
  /** 混批规则 JSON（{mixAmount?, mixNumber?}）或 null */
  seller_mix_setting: string | null;
  one_piece_free_postage: number;
}

/** 供应商店铺只读子集（v2_supplier_shop；title/nickname 用于买家名展示） */
export interface SupplierShopRead {
  title: string;
  nickname: string | null;
}

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

// ---------------------------------------------------------------------------
// 加购（旧 AddCartMutation + GoodsInfoInputType 1:1）
// ---------------------------------------------------------------------------

/**
 * 加购商品行（旧 GoodsInfoInputType 全字段 1:1）。
 *
 * ⚠ 旧 GraphQL 用 `alias` 把外部名映射到 DB 列名（FBA→yanhuofba、addFrom→add_from…）；
 * REST 面**保留外部名**（客户端契约不变），映射在域内 prepareCarts 完成。
 * `props` 的 name/value 允许 null：旧代码显式跳过 `''`/null 项（怪癖 S40）。
 */
export const goodsInfoInputSchema = z.object({
  /** taobao / 1688 / transshipment，其他原样落 goodssite */
  platform: z.string().min(1),
  productId: z.number().int().optional(),
  url: z.string().optional(),
  shopNick: z.string().optional(),
  title: z.string(),
  img: z.string().optional(),
  price: z.number().optional(),
  onePiecePrice: z.number().optional(),
  offerPrice: z.number().optional(),
  /** 一件零售价；未设置 = null（旧注释：不会转成 0） */
  retailPrice: z.number().optional(),
  promotionPrice: z.number().optional(),
  onePieceFreePostage: z.number().int().optional(),
  /** 阶梯价 JSON 字符串（[{"price":"6.5","startQuantity":3,...}]） */
  priceRange: z.string().optional(),
  /** 混批 JSON 字符串（{"generalHunpi":false,"mixAmount":800,"mixNumber":5}） */
  sellerMixSetting: z.string().optional(),
  quantity: z.number().int(),
  props: z.array(z.object({ name: z.string().nullable(), value: z.string().nullable() })).optional(),
  skuId: z.string().optional(),
  minOrderQuantity: z.number().int().optional(),
  sendPrice: z.number().optional(),
  remark: z.string().optional(),
  expressNo: z.string().optional(),
  FBA: z.string().optional(),
  ASIN: z.string().optional(),
  FNSKU: z.string().optional(),
  outId: z.string().optional(),
  ecommerceOrderItemUniqueId: z.string().optional(),
  var1: z.string().optional(),
  var2: z.string().optional(),
  var3: z.string().optional(),
  var4: z.string().optional(),
  var5: z.string().optional(),
  var6: z.string().optional(),
  var7: z.string().optional(),
  var8: z.string().optional(),
  var9: z.string().optional(),
  var10: z.string().optional(),
  var11: z.string().optional(),
  var12: z.string().optional(),
  /** 来源：0老网站/1新网站/2下单插件/3订单列表再买一单/4收藏夹再买一单/5新UI链接下单/6新UI订单列表再买一单/7新UI收藏夹再买一单/8OpenAPI/10无在库导入/11Excel导入 */
  addFrom: z.number().int().optional(),
  addFromMemo: z.string().optional(),
});
export type GoodsInfoInput = z.infer<typeof goodsInfoInputSchema>;

/** 加购入参（旧 addCart args 1:1） */
export const addCartSchema = z.object({
  goodsList: z.array(goodsInfoInputSchema).min(1),
  /** null/未传 = 跳过校验与合并直接创建；1 = 仅校验（旧实现直接返回空串）；2 = 合并重复数量 */
  isValidate: z.number().int().nullable().optional(),
  /** true = 返回购物车 gid 集合（逗号分隔），false/未传 = 'done' */
  returnCartId: z.boolean().optional(),
  /** 开放接口下单：最低起订量按同一商品全部 SKU 合计数量判断 */
  checkProductMinOrderQuantity: z.boolean().optional(),
});
export type AddCartInput = z.infer<typeof addCartSchema>;

/**
 * 加购出参（旧返回 String：'done' / gid 串 / 再买一单跳转 URL）。
 * REST 面保持 `result` 原字符串（1:1），额外结构化给出 `cartIds` 与 `redirectUrl`。
 */
export const addCartResultSchema = z.object({
  result: z.string(),
  cartIds: z.array(z.number().int()),
  redirectUrl: z.string().nullable(),
});
export type AddCartResult = z.infer<typeof addCartResultSchema>;
