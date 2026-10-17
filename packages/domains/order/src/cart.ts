import {
  cartListQuerySchema,
  cartMoneyQuerySchema,
  type CartGroup,
  type CartMoney,
  type CartRow,
  type SupplierProductSummary,
} from '@crossbuy/contract';
import type { Principal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import { parseSkuName } from './list-helpers';
import { GOODS_SITE_1688, ORDER_TYPE_DAIGOU } from './webhook-1688';
import type { OrderRepository } from './repository';

/**
 * cart 读路径（旧 ListCartQuery + GetCartMoneyQuery + Cart::countMoney 族 1:1）。
 * dg_cart / v2_supplier_product 属主 = order 域（docs/plans/07 §四）——service 落本域。
 *
 * 语义锚点：
 * - 旧 Cart::countMoney 会把 `deducted_service_fee` 写回 $cart->extend——**纯内存态**
 *   （无 save()，GraphQL 输出不含 extend，下单服务自己重算），R1 不复现该变更（注释锁定）。
 * - 金额 round2 = PHP round 语义（金额恒正，HALF_UP 等价）。
 */

/** 购物车行（repository select 子集） */
export type CartEntity = Awaited<ReturnType<OrderRepository['listCarts']>>[number];
/** 供应商商品行（repository select 子集） */
export type SupplierProductEntity = NonNullable<Awaited<ReturnType<OrderRepository['listSupplierProducts']>> extends Map<number, infer V> ? V : never>;

/** 权益预览端口（旧 UserBenefitService::previewFeeDeduct——member 域属主；null = 无可用权益） */
export interface BenefitPort {
  /** 开关开启且存在可用权益时返回 { canDeduct, maxDeduct }；否则 null */
  previewFeeDeduct(uid: number, originalServerMoney: number): Promise<{ canDeduct: number; maxDeduct: number } | null>;
}

/** 汇率端口（旧 Currency::convert CNY→JPY，缓存语义在端口内） */
export interface CurrencyPort {
  cnyToJpy(): Promise<number>;
}

/**
 * 会员金额因子端口（dg_users 属主 = member 域：dfflag/dffee/utype——
 * 结构化最小接口，组合根用 member 域 service 装配）。
 */
export interface MemberFactorsPort {
  /** 旧 $user 的 dfflag/dffee/utype（不存在 = null） */
  getMoneyFactors(uid: number): Promise<{ isDf: boolean; dffee: number; utype: number } | null>;
}

/** round2（PHP round；金额恒正） */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// 旧 Order 常量复用（正本在 webhook-1688 / Order.php）：TYPE_1688=goodssite、转运=2、代发=3
const CART_TYPE_1688 = GOODS_SITE_1688;
const ORDER_TYPE_ZHUANYUN = 2;
const ORDER_TYPE_DAIFA = 3;

/** 旧 storedRetailPrice：null/''/0 视为未设置 */
function storedRetailPrice(cart: CartEntity): number | null {
  const value = cart.retail_price;
  if (value === null || value === 0) return null;
  return value;
}

/** 旧 filterMixSettingShops：混批金额/件数达标的店铺 id 集 */
export function filterMixSettingShops(
  shopQuantities: Map<number, { num: number; money: number; rule: { mixAmount?: number; mixNumber?: number } | null }>,
): number[] {
  if (shopQuantities.size === 0) return [];
  const shopIds: number[] = [];
  for (const [shopId, setting] of shopQuantities) {
    const mixAmount = setting.rule?.mixAmount ?? 0;
    const mixNumber = setting.rule?.mixNumber ?? 0;
    if (mixAmount && setting.money >= mixAmount) {
      shopIds.push(shopId);
      continue;
    }
    if (mixNumber && setting.num >= mixNumber) {
      shopIds.push(shopId);
    }
  }
  return shopIds;
}

/** 旧 calculateUnitPriceByQuantity：同商品合计数量的阶梯单价 */
export function calculateUnitPriceByQuantity(
  cart: CartEntity,
  product: SupplierProductEntity | undefined,
  totalQuantity: number,
  mixShopIds: number[],
): number {
  // 1688 零售价改造：同商品合计 1 件使用 retail_price（不回落批发价、不转 0）
  if (Math.trunc(totalQuantity) === 1) {
    const retailPrice = storedRetailPrice(cart);
    if (retailPrice) return retailPrice;
  }
  if (!product) return cart.goodsprice;
  const priceRange = Array.isArray(product.price_range)
    ? (product.price_range as Array<{ startQuantity?: number; price?: number }>)
    : null;
  if (!priceRange || priceRange.length === 0) return cart.goodsprice;

  const startQuantity = priceRange[0]?.startQuantity ?? 1;
  const minOrderQuantity = product.min_order_quantity;

  // 不满足最小起批且支持混批的商品：店铺混批达标 → 原价
  const mixSetting = product.seller_mix_setting ? (JSON.parse(product.seller_mix_setting) as { mixAmount?: number; mixNumber?: number }) : null;
  if (totalQuantity < startQuantity && mixSetting && product.shop_id !== null && mixShopIds.includes(product.shop_id)) {
    return cart.goodsprice;
  }
  // 一件包邮
  if (product.one_piece_free_postage && totalQuantity === 1 && 1 < startQuantity) {
    return cart.one_piece_price;
  }
  // 分销价
  if (startQuantity > minOrderQuantity && totalQuantity < startQuantity) {
    return cart.offer_price || cart.goodsprice;
  }
  // 阶梯只有一组：可能有不同 SKU 单价，不算阶梯
  if (priceRange.length <= 1) return cart.goodsprice;

  // 起始数量倒序，取满足的最大起始数量价
  let targetPrice = cart.goodsprice;
  const sorted = [...priceRange].sort((a, b) => (b.startQuantity ?? 1) - (a.startQuantity ?? 1));
  for (const range of sorted) {
    if (totalQuantity >= (range.startQuantity ?? 1)) {
      targetPrice = range.price ?? cart.goodsprice;
      break;
    }
  }
  return targetPrice;
}

/** 旧 calculateTierPrices：[gid => 单价]（仅 1688 + 有 supplier_product_id 的行参与） */
export function calculateTierPrices(
  carts: CartEntity[],
  products: Map<number, SupplierProductEntity>,
): Map<number, number> {
  const tierPrices = new Map<number, number>();
  const productQuantities = new Map<number, number>();
  const productCarts: CartEntity[] = [];
  const shopQuantities = new Map<number, { num: number; money: number; rule: { mixAmount?: number; mixNumber?: number } | null }>();

  for (const cart of carts) {
    if (cart.goodssite !== CART_TYPE_1688) continue;
    if (!cart.supplier_product_id) continue;
    const productId = cart.supplier_product_id;
    productQuantities.set(productId, (productQuantities.get(productId) ?? 0) + cart.goodsnum);
    productCarts.push(cart);

    const product = products.get(productId);
    if (product?.seller_mix_setting && product.shop_id !== null) {
      const entry = shopQuantities.get(product.shop_id) ?? { num: 0, money: 0, rule: null };
      let rule: { mixAmount?: number; mixNumber?: number } | null = entry.rule;
      if (!rule) {
        try {
          rule = JSON.parse(product.seller_mix_setting) as { mixAmount?: number; mixNumber?: number };
        } catch {
          rule = null;
        }
      }
      entry.rule = rule;
      entry.money += cart.goodsnum * cart.goodsprice;
      entry.num += cart.goodsnum;
      shopQuantities.set(product.shop_id, entry);
    }
  }

  const mixShopIds = filterMixSettingShops(shopQuantities);
  for (const cart of productCarts) {
    const totalQuantity = productQuantities.get(cart.supplier_product_id!) ?? 0;
    tierPrices.set(cart.gid, calculateUnitPriceByQuantity(cart, products.get(cart.supplier_product_id!), totalQuantity, mixShopIds));
  }
  return tierPrices;
}

/** 旧 Cart::countMoney 出参（金额 round2） */
export interface CartMoneyBreakdown {
  goodsMoney: number;
  originalServerMoney: number;
  maxDeductServerMoney: number;
  deductedServerMoney: number;
  serverMoney: number;
  totalMoney: number;
}

/**
 * 旧 Cart::countMoney 1:1。
 * @param userCharged 付费会员（utype = UTYPE_CHARGED）——服务费归零
 * @param dffee 代发单件服务费（user.dffee）
 * @param feeDeductPreview 权益预览（null = 不抵扣）；付费会员在外层被视为不需要抵扣
 */
export function countMoney(
  carts: CartEntity[],
  products: Map<number, SupplierProductEntity>,
  userCharged: boolean,
  dffee: number,
  feeDeductPreview: { canDeduct: number; maxDeduct: number } | null,
): CartMoneyBreakdown {
  let originalDaigouServerMoney = 0;
  let originalDaifaServerMoney = 0;
  let daigouServerMoney = 0;
  let daifaServerMoney = 0;
  let goodsMoney = 0;
  let deductedServerMoney = 0;
  let remainingDeduct = feeDeductPreview ? feeDeductPreview.canDeduct : 0;
  const maxDeductServerMoney = feeDeductPreview ? feeDeductPreview.maxDeduct : 0;

  const tierPrices = calculateTierPrices(carts, products);

  for (const cart of carts) {
    const unitPrice = tierPrices.get(cart.gid) ?? cart.goodsprice;
    switch (cart.type) {
      case ORDER_TYPE_DAIGOU: {
        const money = unitPrice * cart.goodsnum;
        goodsMoney += money;
        const originalFee = Math.ceil(money * 0.05 * 100) / 100;
        originalDaigouServerMoney += originalFee;
        if (remainingDeduct > 0) {
          if (remainingDeduct >= originalFee) {
            deductedServerMoney += originalFee;
            remainingDeduct -= originalFee;
          } else {
            deductedServerMoney += remainingDeduct;
            daigouServerMoney += originalFee - remainingDeduct;
            remainingDeduct = 0;
          }
        } else {
          daigouServerMoney += originalFee;
        }
        break;
      }
      case ORDER_TYPE_DAIFA: {
        goodsMoney += unitPrice * cart.goodsnum;
        const originalFee = dffee * cart.goodsnum;
        originalDaifaServerMoney += originalFee;
        daifaServerMoney += originalFee;
        break;
      }
    }
  }
  if (userCharged) {
    daigouServerMoney = 0;
    daifaServerMoney = 0;
  }

  const originalServerMoney = originalDaigouServerMoney + originalDaifaServerMoney;
  const serverMoney = daigouServerMoney + daifaServerMoney;
  return {
    goodsMoney: round2(goodsMoney),
    originalServerMoney: round2(originalServerMoney),
    maxDeductServerMoney: round2(maxDeductServerMoney),
    deductedServerMoney: round2(deductedServerMoney),
    serverMoney: round2(serverMoney),
    totalMoney: round2(goodsMoney + serverMoney),
  };
}

/** 供应商商品 → 契约摘要（price_range/seller_mix_setting JSON 解析容错 1:1 旧模型属性） */
function toProductSummary(row: SupplierProductEntity): SupplierProductSummary {
  let priceRange: SupplierProductSummary['priceRange'] = null;
  if (Array.isArray(row.price_range)) {
    priceRange = (row.price_range as Array<{ startQuantity?: unknown; price?: unknown }>).map((r) => ({
      startQuantity: Number(r.startQuantity ?? 0),
      price: Number(r.price ?? 0),
    }));
  }
  let sellerMixSetting: SupplierProductSummary['sellerMixSetting'] = null;
  if (row.seller_mix_setting) {
    try {
      const parsed = JSON.parse(row.seller_mix_setting) as { mixAmount?: unknown; mixNumber?: unknown };
      sellerMixSetting = {
        ...(parsed.mixAmount !== undefined ? { mixAmount: Number(parsed.mixAmount) } : {}),
        ...(parsed.mixNumber !== undefined ? { mixNumber: Number(parsed.mixNumber) } : {}),
      };
    } catch {
      sellerMixSetting = null;
    }
  }
  return {
    id: row.id,
    shopId: row.shop_id,
    platform: row.platform,
    goodsId: row.goods_id,
    goodsName: row.goods_name,
    priceRange,
    minOrderQuantity: row.min_order_quantity,
    sellerMixSetting,
    onePieceFreePostage: row.one_piece_free_postage !== 0,
  };
}

/** 购物车实体 → 契约行（旧 Member/CartType resolve* 1:1） */
function toCartRow(cart: CartEntity, product: SupplierProductEntity | undefined): CartRow {
  const skus = parseSkuName(cart.sku_name, cart.goodssize, cart.goodscolor);
  const skuTrans = Array.isArray(cart.sku_trans)
    ? (cart.sku_trans as Array<{ name: string; value: string }>)
    : skus;
  const name = (v: string | null): string | null => (v === '' ? null : v);
  return {
    gid: cart.gid,
    uid: cart.uid,
    uname: cart.uname,
    type: cart.type ?? 0,
    supplierProduct: product ? toProductSummary(product) : null,
    goodsName: cart.goodsname,
    goodsNameTrans: cart.goods_name_trans || cart.goodsname,
    goodsUrl: cart.goodsurl,
    goodsImg: cart.goodsimg,
    goodsSeller: cart.goodsseller,
    goodsSite: cart.goodssite,
    skuName: cart.sku_name || null,
    goodSkus: skus,
    goodSkuTrans: skuTrans,
    ship: cart.ship,
    goodsPrice: String(cart.goodsprice),
    onePiecePrice: String(cart.one_piece_price || cart.goodsprice),
    offerPrice: String(cart.offer_price || cart.goodsprice),
    retailPrice: cart.retail_price === null || cart.retail_price === 0 ? null : String(cart.retail_price),
    goodsNum: cart.goodsnum,
    minOrderQuantity: cart.min_order_quantity,
    var1: name(cart.var1),
    var2: name(cart.var2),
    var3: name(cart.var3),
    var4: name(cart.var4),
    var5: name(cart.var5),
    var6: name(cart.var6),
    var7: name(cart.var7),
    var8: name(cart.var8),
    var9: name(cart.var9),
    var10: name(cart.var10),
    var11: name(cart.var11),
    var12: name(cart.var12),
    fba: name(cart.yanhuofba),
    asin: name(cart.yanhuoasin),
    fnsku: name(cart.yanhuofnsku),
    outId: cart.outid,
    service: name(cart.yanhuozengzhi),
    sendPrice: String(cart.sendprice),
    goodsRemark: cart.goodsremark,
    addFrom: cart.add_from ?? 0,
    expressNo: cart.expressno,
    createdAt: cart.addtime ? new Date(cart.addtime * 1000).toISOString() : '',
  };
}

export interface CartServiceDeps {
  repository: OrderRepository;
  memberFactorsPort: MemberFactorsPort;
  benefitPort: BenefitPort;
  currencyPort: CurrencyPort;
  /** 旧 config('benefit.fee_deduct_preview_switch') !== null（组合根读 env，域内禁直读） */
  feeDeductPreviewEnabled: boolean;
  /** UTYPE_CHARGED 值（旧 User::UTYPE_CHARGED） */
  utypeCharged: number;
}

export class CartService {
  constructor(protected readonly deps: CartServiceDeps) {}

  /**
   * 购物车列表（旧 listCart 1:1）：dfflag 分流（DF 强制 type=3；普通 type∈[1,2]）+
   * ids 过滤 + sku 桶聚拢（md5(goodsid+sku) 桶序 = 首现序）→ 按卖家分组。
   */
  async listCarts(
    principal: Principal,
    query: unknown,
  ): Promise<Result<CartGroup[], { code: string; message: string }>> {
    if (principal.kind !== 'member') {
      return err({ code: 'NO_PERMISSIONS', message: '非会员主体' });
    }
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'NO_PERMISSIONS', message: 'Principal 非法' });
    }
    const parsed = cartListQuerySchema.parse(query ?? {});
    const factors = await this.deps.memberFactorsPort.getMoneyFactors(uid);
    if (!factors) return err({ code: 'MEMBER_NOT_FOUND', message: '会员不存在' });
    const isDf = factors.isDf;
    const db = this.deps.repository.db;

    const gids = parsed.ids
      ? parsed.ids.split(',').map(Number).filter(Number.isInteger)
      : undefined;
    const types = isDf ? [ORDER_TYPE_DAIFA] : [ORDER_TYPE_DAIGOU, ORDER_TYPE_ZHUANYUN];
    const carts = await this.deps.repository.listCarts(db, { uid, gids, types });

    const products = await this.deps.repository.listSupplierProducts(
      db,
      carts.map((c) => c.supplier_product_id).filter((v): v is number => v !== null),
    );

    // 旧分组的桶聚拢：md5(goodsid + sku json) → 桶序 = 首现序 → flatten
    const buckets = new Map<string, CartEntity[]>();
    for (const cart of carts) {
      const skus = parseSkuName(cart.sku_name, cart.goodssize, cart.goodscolor);
      skus.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
      const hashKey = `${cart.goodsid ?? ''}-${JSON.stringify(skus)}`;
      const bucket = buckets.get(hashKey) ?? [];
      bucket.push(cart);
      buckets.set(hashKey, bucket);
    }
    const flattened = [...buckets.values()].flat();

    // 按卖家分组（首现序）
    const groups = new Map<string, CartGroup>();
    for (const cart of flattened) {
      const key = cart.goodsseller ?? '';
      const group = groups.get(key) ?? {
        goodsSite: cart.goodssite,
        goodsSeller: cart.goodsseller,
        carts: [],
      };
      group.carts.push(toCartRow(cart, cart.supplier_product_id ? products.get(cart.supplier_product_id) : undefined));
      groups.set(key, group);
    }
    return ok([...groups.values()]);
  }

  /**
   * 购物车金额（旧 getCartMoney 1:1）：dfflag 定 type（DF=3 / 普通=1，**单值**——与列表的双值不同）
   * → 权益预览（仅代购 + 开关开）→ countMoney → 汇率换算。
   */
  async getCartMoney(
    principal: Principal,
    query: unknown,
  ): Promise<Result<CartMoney, { code: string; message: string }>> {
    if (principal.kind !== 'member') {
      return err({ code: 'NO_PERMISSIONS', message: '非会员主体' });
    }
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'NO_PERMISSIONS', message: 'Principal 非法' });
    }
    const parsed = cartMoneyQuerySchema.parse(query ?? {});
    const factors = await this.deps.memberFactorsPort.getMoneyFactors(uid);
    if (!factors) return err({ code: 'MEMBER_NOT_FOUND', message: '会员不存在' });
    const isDf = factors.isDf;
    const db = this.deps.repository.db;

    const gids = parsed.ids.split(',').map(Number).filter(Number.isInteger);
    const type = isDf ? ORDER_TYPE_DAIFA : ORDER_TYPE_DAIGOU;
    const carts = await this.deps.repository.listCarts(db, { uid, gids, types: [type] });
    const products = await this.deps.repository.listSupplierProducts(
      db,
      carts.map((c) => c.supplier_product_id).filter((v): v is number => v !== null),
    );

    // ① 手续费抵扣权益预览（仅代购 + 开关开；DF/付费会员外层归零）
    let feeDeductPreview: { canDeduct: number; maxDeduct: number } | null = null;
    if (type === ORDER_TYPE_DAIGOU && this.deps.feeDeductPreviewEnabled) {
      const tierPrices = calculateTierPrices(carts, products);
      let originalServerMoney = 0;
      for (const cart of carts) {
        const unitPrice = tierPrices.get(cart.gid) ?? cart.goodsprice;
        originalServerMoney += unitPrice * cart.goodsnum * 0.05;
      }
      feeDeductPreview = await this.deps.benefitPort.previewFeeDeduct(uid, originalServerMoney);
    }

    // ② countMoney（utype = UTYPE_CHARGED → 服务费归零；dffee 来自会员因子端口）
    const money = countMoney(
      carts,
      products,
      factors.utype === this.deps.utypeCharged,
      factors.dffee ?? 0,
      feeDeductPreview,
    );

    // ③ 汇率换算（CNY→JPY，round2）
    const rate = await this.deps.currencyPort.cnyToJpy();
    return ok({
      goodsMoney: money.goodsMoney.toFixed(2),
      originalServerMoney: money.originalServerMoney.toFixed(2),
      maxDeductServerMoney: money.maxDeductServerMoney.toFixed(2),
      deductedServerMoney: money.deductedServerMoney.toFixed(2),
      serverMoney: money.serverMoney.toFixed(2),
      totalMoney: money.totalMoney.toFixed(2),
      exchangeMoney: (Math.round(money.totalMoney * rate * 100) / 100).toFixed(2),
    });
  }
}
