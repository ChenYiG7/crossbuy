import { createHash } from 'node:crypto';
import type { Principal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import { addCartSchema, type AddCartResult, type GoodsInfoInput } from '@crossbuy/contract';

import type { OrderError } from './errors';
import { orderError } from './errors';
import { ORDER_TYPE } from './legacy-constants';
import { parseSkuName } from './list-helpers';
import type { CreateCartData, OrderRepository } from './repository';

/**
 * 加购链路（旧 `AddCartMutation`（1496 行）1:1）。dg_cart 属主 = order 域。
 *
 * ★ 与旧代码的三处**刻意不同**（都是行为等价或铁律要求的，改动点已登记 docs/plans/08）：
 * - 事务后副作用（4 个 Job）改 AFTER_COMMIT 端口（铁律 7；旧 dispatch 无队列保障）。
 * - 供应商商品/店铺的**写**走 purchase 域端口（表唯一属主；旧代码在 Mutation 里直写）。
 * - 平台 SDK（商品详情 / 1688 店铺反解 / URL 解析）抽端口，R1 恒 null/空（S39~S41）。
 *
 * ⚠ 一条**必须照抄**的怪癖：`isValidate == 1` 在**预处理之前**就 `return ''`
 * （旧代码 :248-250），所以「仅校验」其实是空操作——重复 gids 的返回分支是死代码。
 */

// ---------------------------------------------------------------------------
// 常量（旧 Order.php）
// ---------------------------------------------------------------------------

/** 旧 Order::TYPE_TAOBAO / TYPE_1688 / TYPE_ZHUANYUN（dg_cart.goodssite 列值） */
const GOODS_SITE_TAOBAO = '淘宝';
const GOODS_SITE_1688 = '1688';
const GOODS_SITE_ZHUANYUN = '転送サービス';
/** 旧 Product::TYPE_TAOBAO / TYPE_1688（v2_supplier_product.platform 列值） */
const PRODUCT_PLATFORM_TAOBAO = 'taobao';
const PRODUCT_PLATFORM_1688 = '1688';
/** 旧转运加购的卖家默认值（goodsseller 为空时） */
const ZHUANYUN_DEFAULT_SELLER = 'shipforme';
/** 旧 yanhuofba 归一化值：非空一律写 'FBA' */
const FBA_LITERAL = 'FBA';
/** 旧 REPURCHASE_ITEMS_QUERY_KEY */
const REPURCHASE_ITEMS_QUERY_KEY = 'repurchaseItems';
/** 再买一单来源（旧 add_from 词表） */
const ADD_FROM_REPURCHASE = 6;

// ---------------------------------------------------------------------------
// 端口（域间禁横向 import：结构化最小接口，组合根装配）
// ---------------------------------------------------------------------------

/** 平台商品详情（旧 PlatformSubAccount::getTaobaoSdk/getAlibabaSdk()->getFormatGoodsInfo） */
export interface PlatformGoodsInfo {
  title: string;
  /** 1688 必须 status === 'published'，否则视为下架（旧 :1265-1270） */
  status?: string | null;
  detailUrl?: string | null;
  minNum?: number | null;
  minOrderQuantity?: number | null;
  sellerMixSetting?: unknown;
  sellerInfo?: {
    openid?: string | null;
    id?: string | number | null;
    nick?: string | null;
    shopName?: string | null;
  } | null;
  skus?: PlatformSku[];
  propsList?: Record<string, string>;
  propsImg?: Record<string, string>;
  itemImgs?: Array<string | { url?: string }>;
}

export interface PlatformSku {
  skuId?: string | null;
  properties?: string | null;
  price?: number | string | null;
  onePiecePrice?: number | string | null;
  offerPrice?: number | string | null;
  retailPrice?: number | string | null;
  promotionPrice?: number | string | null;
  skuAttributes?: Array<{ attributeName?: string | null; value?: string | null } | null> | null;
}

export interface PlatformGoodsInfoPort {
  fetch(input: {
    goodsSite: string;
    goodsId: string;
    miId: string;
  }): Promise<PlatformGoodsInfo | null>;
}

/** 1688 店铺反解（旧 Alibaba::searchShopNameByGoodsId / decryptOpenidFromFenxiaoApi） */
export interface AlibabaShopPort {
  searchShopNameByGoodsId(goodsId: string): Promise<string | null>;
  decryptOpenidFromFenxiaoApi(openid: string): Promise<string | null>;
}

/** 商品 URL 解析（旧 ContentParser::parse —— 淘宝/1688 双解析器 + 1 分钟缓存） */
export interface GoodsUrlParserPort {
  parse(url: string): Promise<Array<{ detail?: { itemId?: string | null; miId?: string | null } }>>;
}

/** 旧 getFrontendUrl($path, $dfflag, false)（env 前缀在组合根） */
export interface FrontendUrlPort {
  build(path: string, isDf: boolean): string;
}

/**
 * 供应商商品（v2_supplier_product 属主 = purchase 域，docs/plans/07 §四）。
 * 旧 `getProduct`：先查 → 未命中抢锁 → 锁内再查 → 建。
 */
export interface SupplierProductPort {
  resolveOrCreate(input: {
    platform: string;
    goodsId: string;
    shopId: number;
    goodsUrl: string;
    goodsName: string;
    imgUrl: string;
    price: number;
    priceRange: Array<{ price: unknown; startQuantity: unknown }> | null;
    minOrderQuantity: number;
    onePieceFreePostage: number;
    sellerMixSetting: unknown | null;
  }): Promise<{ id: number } | null>;
}

/** 供应商店铺映射（v2_supplier_shop 属主 = purchase 域） */
export interface SupplierShopPort {
  findByOpenId(
    appid: number,
    openid: string,
  ): Promise<{ id: number; title: string; nickname: string | null } | null>;
  create(
    appid: number,
    openid: string,
    title: string,
  ): Promise<{ id: number; title: string; nickname: string | null }>;
  update(
    id: number,
    patch: { title?: string; nickname?: string | null },
  ): Promise<{ id: number; title: string; nickname: string | null }>;
}

/** 加购后 Job（旧 4 个 dispatch；R1 组合根 no-op，随 worker 落地接线 TODO(#16)） */
export interface AddCartSideEffectPort {
  /** 旧 ProcessSyncSupplierProduct::dispatch（补商品数据） */
  enqueueSyncSupplierProduct(productId: number): Promise<void>;
  /** 旧 ProcessSubscribeSupplierProduct::dispatch（订阅商品） */
  enqueueSubscribeSupplierProduct(productId: number): Promise<void>;
  /** 旧 ProcessCompletionGoodsInfo::dispatch（1688/淘宝 且缺图或缺店铺名） */
  enqueueCompletionGoodsInfoForCart(gid: number): Promise<void>;
  /** 旧 ProcessTranslateCartGoodsInfo::dispatch（有 goodsurl 必投） */
  enqueueTranslateCartGoodsInfo(gid: number): Promise<void>;
}

/** 会员身份（dg_users 属主 = member 域；复用购物车金额的窄投影端口） */
export interface AddCartMemberPort {
  getMoneyFactors(
    uid: number,
  ): Promise<{ isDf: boolean; dffee: number; utype: number; uname: string | null } | null>;
}

export interface AddCartDeps {
  repository: OrderRepository;
  memberPort: AddCartMemberPort;
  urlParser: GoodsUrlParserPort;
  platformGoods: PlatformGoodsInfoPort;
  alibabaShop: AlibabaShopPort;
  supplierProduct: SupplierProductPort;
  supplierShop: SupplierShopPort;
  sideEffects: AddCartSideEffectPort;
  frontendUrl: FrontendUrlPort;
  /** 旧 env('ALIBABA_FENXIAO_APPID') */
  alibabaFenxiaoAppid: number;
  /** 旧 env('CART_MAX_COUNT', 10000)；<= 0 = 不限制 */
  cartMaxCount: number;
  /** 结构化日志（旧 logMessage；R2 接 logger） */
  log?: (message: string, context?: unknown) => void;
  clock?: () => Date;
}

// ---------------------------------------------------------------------------
// 纯函数（单测直锁；无 IO）
// ---------------------------------------------------------------------------

/** 旧 roundedPriceOrZero：null/'' → 0.0，否则 round(x, 2) */
export function roundedPriceOrZero(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** 旧 formatSkuNameHtml（sku_name 的 HTML 串，1:1 含空格位置） */
export function formatSkuNameHtml(props: Array<{ name: string; value: string }>): string {
  let html = '';
  for (const prop of props) {
    html += `<font color=red>${prop.name}:</font><font color=green> ${prop.value} </font>`;
  }
  return html;
}

/** 旧 sortAttrs：按 name 的 strcmp 排序（等价 localeCompare 之外的字节序 → 用 < 比较） */
export function sortAttrs(
  attrs: Array<{ name?: string | null; value?: string | null }>,
): Array<{ name: string; value: string }> {
  const copy = attrs.map((a) => ({ name: a.name ?? '', value: a.value ?? '' }));
  copy.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return copy;
}

/**
 * 旧 generateSkuAttrsHash：`md5(json_encode(sortAttrs($attrs), JSON_UNESCAPED_UNICODE))`。
 * ⚠ 只需**判等**（不与库里旧哈希比对），故用 JSON.stringify + md5 语义等价实现。
 */
export function generateSkuAttrsHash(
  attrs: Array<{ name?: string | null; value?: string | null }>,
): string {
  return createHash('md5')
    .update(JSON.stringify(sortAttrs(attrs)))
    .digest('hex');
}

/** 旧 parseSkuAttrsFromCart：从 sku_name 反解属性（空 → []） */
export function parseSkuAttrsFromCart(
  skuName: string | null | undefined,
): Array<{ name: string; value: string }> {
  if (!skuName) return [];
  return parseSkuName(skuName, null, null);
}

/** 旧 compareExtraFields：17 列逐项 `empty() ? '' : v` 宽松比较（全等才合并） */
export const EXTRA_COMPARE_FIELDS = [
  'yanhuofba',
  'yanhuoasin',
  'yanhuofnsku',
  'outid',
  'var1',
  'var2',
  'var3',
  'var4',
  'var5',
  'var6',
  'var7',
  'var8',
  'var9',
  'var10',
  'var11',
  'var12',
  'goodsremark',
] as const;

export function compareExtraFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  for (const key of EXTRA_COMPARE_FIELDS) {
    const a = normalizeEmpty(existing[key]);
    const b = normalizeEmpty(incoming[key]);
    if (a !== b) return false;
  }
  return true;
}

/** PHP empty() 对字符串/null 的语义（'0' 也算 empty——与旧 `!=` 宽松比较同形） */
function normalizeEmpty(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value === '0' ? '' : value;
  return String(value);
}

/** 旧 propsFromSkuAttributes（1688 skuAttributes 优先，键名不稳定才回落 props_list） */
export function propsFromSkuAttributes(sku: PlatformSku): Array<{ name: string; value: string }> {
  const attributes = sku.skuAttributes;
  if (!Array.isArray(attributes)) return [];
  const props: Array<{ name: string; value: string }> = [];
  for (const attr of attributes) {
    if (!attr || typeof attr !== 'object') continue;
    const name = (attr.attributeName ?? '').trim();
    const value = (attr.value ?? '').trim();
    if (name === '' || value === '') continue;
    props.push({ name, value });
  }
  return props;
}

/** 旧 propsFromPlatformSku：skuAttributes 为空时按 `properties` 查 props_list */
export function propsFromPlatformSku(
  sku: PlatformSku,
  propsList: Record<string, string>,
): Array<{ name: string; value: string }> {
  const fromAttributes = propsFromSkuAttributes(sku);
  if (fromAttributes.length > 0) return fromAttributes;

  const props: Array<{ name: string; value: string }> = [];
  for (const propKey of String(sku.properties ?? '').split(';')) {
    if (propKey === '') continue;
    const raw = propsList[propKey];
    if (!raw) continue;
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const name = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (name === '' || value === '') continue;
    props.push({ name, value });
  }
  return props;
}

/** 旧 normalizeAttrPairs：小写 + 排序后的 `name:value` 串（用于 SKU 匹配） */
export function normalizeAttrPairs(
  attrs: Array<{ name?: string | null; value?: string | null }>,
): string[] {
  const pairs: string[] = [];
  for (const attr of attrs) {
    const name = (attr.name ?? '').trim().toLowerCase();
    const value = (attr.value ?? '').trim().toLowerCase();
    if (name === '' || value === '') continue;
    pairs.push(`${name}:${value}`);
  }
  pairs.sort();
  return pairs;
}

/** 旧 attrsFromPlatformSku：平台 SKU 侧的属性串（与 normalizeAttrPairs 同形） */
export function attrsFromPlatformSku(
  sku: PlatformSku,
  propsList: Record<string, string>,
): string[] {
  const pairs: string[] = [];
  for (const propKey of String(sku.properties ?? '').split(';')) {
    if (propKey === '') continue;
    const raw = propsList[propKey];
    if (!raw) continue;
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const name = raw.slice(0, idx).trim().toLowerCase();
    const value = raw
      .slice(idx + 1)
      .trim()
      .toLowerCase();
    if (name === '' || value === '') continue;
    pairs.push(`${name}:${value}`);
  }
  pairs.sort();
  return pairs;
}

/** 旧 resolvePlatformSku：skuId 精确 → props 全等 → 仅一个 SKU 时直接取 */
export function resolvePlatformSku(
  goodsInfo: PlatformGoodsInfo,
  cart: { shangpin_sku?: string | null },
  attrs: Array<{ name?: string | null; value?: string | null }> = [],
): PlatformSku | null {
  const skus = goodsInfo.skus ?? [];
  if (skus.length === 0) return null;

  let matched: PlatformSku | null = null;
  if (cart.shangpin_sku) {
    for (const sku of skus) {
      const skuId = String(sku.skuId ?? '');
      if (skuId !== '' && skuId === String(cart.shangpin_sku)) {
        matched = sku;
        break;
      }
    }
  }

  if (!matched && attrs.length > 0) {
    const expected = normalizeAttrPairs(attrs);
    const propsList = goodsInfo.propsList ?? {};
    if (expected.length > 0) {
      for (const sku of skus) {
        if (attrsFromPlatformSku(sku, propsList).join('|') === expected.join('|')) {
          matched = sku;
          break;
        }
      }
    }
  }

  if (!matched && skus.length === 1) return skus[0] ?? null;
  return matched;
}

/** 旧 resolvePlatformImage：先按 SKU properties 找 props_img，再回落首张 item_imgs */
export function resolvePlatformImage(goodsInfo: PlatformGoodsInfo, sku: PlatformSku): string {
  const propsImg = goodsInfo.propsImg ?? {};
  for (const propKey of String(sku.properties ?? '').split(';')) {
    if (propKey === '') continue;
    const img = propsImg[propKey];
    if (img) return img;
  }
  const itemImgs = goodsInfo.itemImgs ?? [];
  const first = itemImgs[0];
  if (typeof first === 'string' && first !== '') return first;
  if (first && typeof first === 'object' && first.url) return first.url;
  return '';
}

/** 旧 mixRule：平台 seller_mix_setting 优先，回落请求里的 sellerMixSetting JSON */
export function mixRule(
  platform: PlatformGoodsInfo | null,
  goodsInfo: GoodsInfoInput,
): { mixAmount: number; mixNumber: number } | null {
  let raw: unknown = null;
  if (platform && platform.sellerMixSetting !== undefined && platform.sellerMixSetting !== null) {
    raw = platform.sellerMixSetting;
  }
  if (raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
    raw = goodsInfo.sellerMixSetting ?? null;
  }
  if (typeof raw === 'string') {
    try {
      const decoded: unknown = JSON.parse(raw);
      raw = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const mixAmount = Number(obj['mixAmount'] ?? 0);
  const mixNumber = Number(obj['mixNumber'] ?? 0);
  if (!(mixAmount > 0) && !(mixNumber > 0)) return null;
  return {
    mixAmount: Number.isFinite(mixAmount) ? mixAmount : 0,
    mixNumber: Number.isFinite(mixNumber) ? mixNumber : 0,
  };
}

/** 旧 resolveMinOrderQuantity：平台 min_num/minOrderQuantity > 0 优先，否则请求值；平台缺失时 <1 视为不校验 */
export function resolveMinOrderQuantity(
  platform: PlatformGoodsInfo | null,
  goodsInfo: GoodsInfoInput,
): number {
  if (platform) {
    const raw = Number(platform.minNum ?? platform.minOrderQuantity ?? 0);
    return raw > 0 ? Math.trunc(raw) : 1;
  }
  return Math.trunc(Number(goodsInfo.minOrderQuantity ?? 0));
}

/** 旧 shopKey：有卖家标识 → `{site}:shop:{id}`，否则退化成 `{site}:goods:{goodsId}` */
export function shopKey(
  platform: PlatformGoodsInfo | null,
  goodsSite: string,
  goodsId: string,
): string {
  const seller = platform?.sellerInfo ?? null;
  let id = '';
  if (seller) {
    id = String(seller.openid ?? seller.id ?? seller.nick ?? '');
  }
  return id === '' ? `${goodsSite}:goods:${goodsId}` : `${goodsSite}:shop:${id}`;
}

/** 最低起订量校验的行聚合（旧 collectProductOrderTotals + productMinOrderLine 的输出） */
export interface MinOrderLine {
  key: string;
  title: string;
  quantity: number;
  amount: number;
  min: number;
  shopKey: string;
  hasMix: boolean;
  mix: { mixAmount: number; mixNumber: number } | null;
}

/** 旧 shopKeysMeetingMix：店铺维度合计达标（金额或件数任一） */
export function shopKeysMeetingMix(products: MinOrderLine[]): Record<string, true> {
  const shops = new Map<
    string,
    { quantity: number; amount: number; mix: { mixAmount: number; mixNumber: number } }
  >();
  for (const product of products) {
    if (!product.hasMix || !product.mix) continue;
    const entry = shops.get(product.shopKey) ?? { quantity: 0, amount: 0, mix: product.mix };
    entry.quantity += product.quantity;
    entry.amount += product.amount;
    shops.set(product.shopKey, entry);
  }
  const met: Record<string, true> = {};
  for (const [key, shop] of shops) {
    const amountMet = shop.mix.mixAmount > 0 && shop.amount >= shop.mix.mixAmount;
    const numberMet = shop.mix.mixNumber > 0 && shop.quantity >= shop.mix.mixNumber;
    if (amountMet || numberMet) met[key] = true;
  }
  return met;
}

/** 旧 assertProductMinOrderQuantity：数量不足且店铺未达混批 → 抛（返回首个违规行） */
export function findBelowMinOrderQuantity(products: MinOrderLine[]): MinOrderLine | null {
  const mixShops = shopKeysMeetingMix(products);
  for (const product of products) {
    if (product.quantity >= product.min) continue;
    if (product.hasMix && mixShops[product.shopKey]) continue;
    return product;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/** 预处理后的一行（旧 prepareCarts 的单元素） */
export interface PreparedCart {
  goodsInfo: GoodsInfoInput;
  cart: Record<string, unknown>;
  skus: Array<{ name: string; value: string }>;
  index: number;
  /** handleSkuDuplication 回填：需要被合并掉的既有购物车行 */
  duplicatedCarts?: Array<{ gid: number; goodsnum: number }>;
}

export class AddCartService {
  constructor(protected readonly deps: AddCartDeps) {}

  /**
   * 加购（旧 batchAddCart 1:1）。
   *
   * @returns `result` 与旧系统同形（'done' / gid 逗号串 / 再买一单跳转 URL）
   */
  async addCarts(
    principal: Principal,
    rawInput: unknown,
  ): Promise<Result<AddCartResult, OrderError>> {
    if (principal.kind !== 'member') return err(orderError('NO_PERMISSIONS'));
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) return err(orderError('NO_PERMISSIONS'));

    const parsed = addCartSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return err(orderError('CART_GOODS_LIST_REQUIRED'));
    }
    const input = parsed.data;
    const isValidate = input.isValidate ?? null;

    // 旧 :248-250：isValidate == 1（仅校验）在预处理前就返回空串——重复 gids 分支是死代码
    if (isValidate === 1) return ok({ result: '', cartIds: [], redirectUrl: null });

    const factors = await this.deps.memberPort.getMoneyFactors(uid);
    if (!factors) return err(orderError('NO_PERMISSIONS'));

    const nowSec = Math.floor((this.deps.clock ?? (() => new Date()))().getTime() / 1000);
    const ctx = {
      uid,
      uname: factors.uname,
      isDf: factors.isDf,
      nowSec,
      goodsInfoCache: new Map<string, PlatformGoodsInfo | null>(),
      productIdsQueue: [] as number[],
    };

    const preparedCarts = await this.prepareCarts(input.goodsList, ctx);

    // 1688/淘宝：一次拉取平台商品，覆盖实价并补全缺失的图片/规格/店铺
    await this.applyPlatformPrices(preparedCarts, ctx);

    // 开放接口下单：最低起订量按同一商品全部 SKU 的合计数量判断
    if (input.checkProductMinOrderQuantity === true) {
      const below = await this.collectBelowMinOrderQuantity(preparedCarts, ctx);
      if (below) {
        return err({
          code: 'CART_BELOW_MIN_ORDER_QUANTITY',
          message: orderError('CART_BELOW_MIN_ORDER_QUANTITY')
            .message.replace(':name', below.title)
            .replace(':qty', String(below.quantity))
            .replace(':min', String(below.min)),
        });
      }
    }

    let finalPreparedCarts: PreparedCart[] = preparedCarts;
    let redirectUrl: string | null = null;
    try {
      finalPreparedCarts = await this.handleSkuDuplication(preparedCarts, ctx, isValidate);

      const countErr = await this.assertCartCountWithinLimit(finalPreparedCarts, ctx, isValidate);
      if (countErr) return err(countErr);

      redirectUrl = await this.bugAgainVerifyProducts(finalPreparedCarts, ctx);
    } catch (e) {
      // 旧 UserError（下架 / URL 不一致）→ REST 面 Result 化
      if (isOrderError(e)) return err(e);
      throw e;
    }
    if (redirectUrl !== null) {
      return ok({ result: redirectUrl, cartIds: [], redirectUrl });
    }

    const cartIds: number[] = [];
    for (const preparedCart of finalPreparedCarts) {
      const cart = preparedCart.cart;
      const goodsInfo = preparedCart.goodsInfo;

      // 1688 + add_from∈{1,2}：反解店铺 openid 维护映射（R1 SDK 恒 null → 整段不触发）
      await this.resolveAlibabaShopSeller(preparedCart);

      if (isEmptyValue(cart['supplier_product_id'])) {
        const product = await this.getProduct(preparedCart);
        cart['supplier_product_id'] = product?.id ?? 0;
      }
      const productId = Number(cart['supplier_product_id'] ?? 0);
      // 防止同商品重复推送队列（旧 productIdsQueue，按**调用**去重——与旧请求级一致）
      if (!ctx.productIdsQueue.includes(productId)) {
        ctx.productIdsQueue.push(productId);
        await this.deps.sideEffects.enqueueSyncSupplierProduct(productId);
        await this.deps.sideEffects.enqueueSubscribeSupplierProduct(productId);
      }

      if (!goodsInfo.props || goodsInfo.props.length === 0) {
        this.deps.log?.('加购物车时没有 sku', { uid: ctx.uid, goodsInfo });
      }

      let created: { gid: number };
      if (
        isValidate === 2 &&
        preparedCart.duplicatedCarts &&
        preparedCart.duplicatedCarts.length > 0
      ) {
        // 旧：事务内先建后删（合并数量）
        const duplicatedGids = preparedCart.duplicatedCarts.map((c) => c.gid);
        const totalQuantity = preparedCart.duplicatedCarts.reduce(
          (acc, c) => acc + (Number(c.goodsnum) || 0),
          Number(cart['goodsnum'] ?? 0),
        );
        cart['goodsnum'] = totalQuantity;
        created = await this.deps.repository.createCart(
          this.deps.repository.db,
          cart as CreateCartData,
        );
        await this.deps.repository.deleteCarts(this.deps.repository.db, duplicatedGids);
      } else {
        created = await this.deps.repository.createCart(
          this.deps.repository.db,
          cart as CreateCartData,
        );
      }

      if (input.returnCartId === true) cartIds.push(created.gid);

      const goodsSite = String(cart['goodssite'] ?? '');
      if (
        (goodsSite === GOODS_SITE_1688 || goodsSite === GOODS_SITE_TAOBAO) &&
        (isEmptyValue(cart['goodsimg']) || isEmptyValue(cart['goodsseller']))
      ) {
        await this.deps.sideEffects.enqueueCompletionGoodsInfoForCart(created.gid);
      }
      if (
        (goodsSite === GOODS_SITE_1688 || goodsSite === GOODS_SITE_TAOBAO) &&
        !isEmptyValue(cart['goodsurl'])
      ) {
        await this.deps.sideEffects.enqueueTranslateCartGoodsInfo(created.gid);
      }
    }

    if (input.returnCartId === true) {
      return ok({ result: cartIds.join(','), cartIds, redirectUrl: null });
    }
    return ok({ result: 'done', cartIds, redirectUrl: null });
  }

  // -------------------------------------------------------------------------
  // 旧 prepareCarts
  // -------------------------------------------------------------------------

  /** 旧 prepareCarts：外部字段名 → dg_cart 列名 + SKU HTML 串 */
  async prepareCarts(
    goodsList: GoodsInfoInput[],
    ctx: { uid: number; uname: string | null; isDf: boolean; nowSec: number },
  ): Promise<PreparedCart[]> {
    const prepared: PreparedCart[] = [];
    for (let index = 0; index < goodsList.length; index += 1) {
      const goodsInfo = goodsList[index]!;
      const cart: Record<string, unknown> = {
        uid: ctx.uid,
        uname: ctx.uname,
        supplier_product_id: goodsInfo.productId ?? 0,
        shangpin_sku: goodsInfo.skuId ?? '',
        goodsurl: isEmptyValue(goodsInfo.url) ? '' : goodsInfo.url,
        goodsname: goodsInfo.title,
        // 旧：转运的 sendPrice 在下面平台分支里覆盖，其余恒 0（前端传入被注释掉）
        sendprice: 0,
        goodsimg: isEmptyValue(goodsInfo.img) ? '' : goodsInfo.img,
        goodsseller: isEmptyValue(goodsInfo.shopNick) ? '' : goodsInfo.shopNick,
        type: ctx.isDf ? ORDER_TYPE.DAIFA : ORDER_TYPE.DAIGOU,
        addtime: ctx.nowSec,
        goodsremark: isEmptyValue(goodsInfo.remark) ? '' : goodsInfo.remark,
        proprice: roundedPriceOrZero(goodsInfo.promotionPrice ?? null),
        min_order_quantity: goodsInfo.minOrderQuantity ?? 0,
        goodsprice: goodsInfo.price ?? 0,
        goodsnum: goodsInfo.quantity ?? 0,
        shangpin_fnsku: goodsInfo.ecommerceOrderItemUniqueId ?? '',
        FNSKU: goodsInfo.FNSKU ?? '',
      };
      // 一件包邮 / 分销 / 零售价（1688 会在 applyPlatformPrices 中用平台实价覆盖）
      cart['one_piece_price'] = goodsInfo.onePiecePrice ?? cart['goodsprice'];
      cart['offer_price'] = goodsInfo.offerPrice ?? cart['goodsprice'];
      cart['retail_price'] = goodsInfo.retailPrice ?? 0;

      // 旧 $extra：isset 才落（未传的列交给 MySQL 非严格模式填 ''）
      const extras: Array<[string, unknown]> = [
        ['yanhuofba', goodsInfo.FBA],
        ['yanhuoasin', goodsInfo.ASIN],
        ['yanhuofnsku', goodsInfo.FNSKU],
        ['outid', goodsInfo.outId],
        ['var1', goodsInfo.var1],
        ['var2', goodsInfo.var2],
        ['var3', goodsInfo.var3],
        ['var4', goodsInfo.var4],
        ['var5', goodsInfo.var5],
        ['var6', goodsInfo.var6],
        ['var7', goodsInfo.var7],
        ['var8', goodsInfo.var8],
        ['var9', goodsInfo.var9],
        ['var10', goodsInfo.var10],
        ['var11', goodsInfo.var11],
        ['var12', goodsInfo.var12],
        ['add_from', goodsInfo.addFrom],
        ['add_from_memo', goodsInfo.addFromMemo],
      ];
      for (const [key, value] of extras) {
        if (value !== undefined) cart[key] = value;
      }
      if (!isEmptyValue(cart['yanhuofba'])) cart['yanhuofba'] = FBA_LITERAL;

      let miId = '';
      switch (goodsInfo.platform) {
        case 'taobao': {
          cart['goodssite'] = GOODS_SITE_TAOBAO;
          const parseResult = await this.deps.urlParser.parse(String(goodsInfo.url ?? ''));
          cart['goodsid'] = parseResult[0]?.detail?.itemId ?? '';
          miId = String(parseResult[0]?.detail?.miId ?? '');
          if (miId !== '') cart['miId'] = miId;
          break;
        }
        case '1688': {
          cart['goodssite'] = GOODS_SITE_1688;
          cart['siteurl'] = 'www.1688.com';
          const parseResult = await this.deps.urlParser.parse(String(goodsInfo.url ?? ''));
          cart['goodsid'] = parseResult[0]?.detail?.itemId ?? '';
          break;
        }
        case 'transshipment': {
          cart['goodssite'] = GOODS_SITE_ZHUANYUN;
          cart['sendprice'] = goodsInfo.sendPrice ?? 0; // 转运支持输入运费
          cart['type'] = ORDER_TYPE.ZHUANYUN;
          cart['siteurl'] = '###';
          cart['expressno'] = isEmptyValue(goodsInfo.expressNo) ? '' : goodsInfo.expressNo;
          if (isEmptyValue(cart['goodsseller'])) cart['goodsseller'] = ZHUANYUN_DEFAULT_SELLER;
          break;
        }
        default:
          cart['goodssite'] = goodsInfo.platform;
      }

      // 旧 props → sku_name HTML（name/value 为 '' 或 null 的项整条跳过）
      const skus: Array<{ name: string; value: string }> = [];
      if (goodsInfo.props && goodsInfo.props.length > 0) {
        let propsHtml = '';
        for (const prop of goodsInfo.props) {
          if (prop.name === null || prop.name === '' || prop.value === null || prop.value === '')
            continue;
          propsHtml += `<font color=red>${prop.name}:</font><font color=green> ${prop.value} </font>`;
          skus.push({ name: prop.name, value: prop.value });
        }
        cart['sku_name'] = propsHtml;
      }

      prepared.push({ goodsInfo, cart, skus, index });
    }
    return prepared;
  }

  // -------------------------------------------------------------------------
  // 旧 applyPlatformPrices
  // -------------------------------------------------------------------------

  /** 平台实价覆盖 + 缺失的图片/规格/店铺补全（失败保留前端价，不阻断） */
  async applyPlatformPrices(
    preparedCarts: PreparedCart[],
    ctx: { uid: number; goodsInfoCache: Map<string, PlatformGoodsInfo | null> },
  ): Promise<void> {
    for (const preparedCart of preparedCarts) {
      const cart = preparedCart.cart;
      const goodsSite = String(cart['goodssite'] ?? '');
      if (goodsSite !== GOODS_SITE_TAOBAO && goodsSite !== GOODS_SITE_1688) continue;

      if (isEmptyValue(cart['goodsid'])) {
        this.deps.log?.('加购物车无法解析 goodsid，跳过平台实价覆盖', {
          uid: ctx.uid,
          goodsInfo: preparedCart.goodsInfo,
        });
        continue;
      }

      const platformGoods = await this.fetchPlatformGoodsInfoForVerify(cart, ctx);
      if (!platformGoods) {
        this.deps.log?.('加购物车拉取平台商品失败，保留前端价格', {
          uid: ctx.uid,
          goodsid: cart['goodsid'],
          goodsurl: cart['goodsurl'],
        });
        continue;
      }

      const matchedSku = resolvePlatformSku(
        platformGoods,
        { shangpin_sku: String(cart['shangpin_sku'] ?? '') },
        preparedCart.skus,
      );
      if (!matchedSku) {
        this.deps.log?.('加购物车匹配平台 SKU 失败，保留前端价格', {
          uid: ctx.uid,
          goodsid: cart['goodsid'],
          shangpin_sku: cart['shangpin_sku'],
          sku_name: cart['sku_name'],
        });
        continue;
      }

      const price = round2(Number(matchedSku.price ?? 0));
      cart['goodsprice'] = price;
      cart['one_piece_price'] =
        matchedSku.onePiecePrice !== undefined && matchedSku.onePiecePrice !== null
          ? round2(Number(matchedSku.onePiecePrice))
          : price;
      cart['offer_price'] =
        matchedSku.offerPrice !== undefined && matchedSku.offerPrice !== null
          ? round2(Number(matchedSku.offerPrice))
          : price;
      cart['retail_price'] =
        matchedSku.retailPrice !== undefined && matchedSku.retailPrice !== null
          ? round2(Number(matchedSku.retailPrice))
          : 0;
      cart['proprice'] = roundedPriceOrZero(matchedSku.promotionPrice ?? null);

      this.fillMissingPlatformGoodsMeta(preparedCart, platformGoods, matchedSku);
    }
  }

  /** 旧 fillMissingPlatformGoodsMeta（不覆盖已有值） */
  fillMissingPlatformGoodsMeta(
    preparedCart: PreparedCart,
    platformGoods: PlatformGoodsInfo,
    matchedSku: PlatformSku,
  ): void {
    const cart = preparedCart.cart;
    if (isEmptyValue(cart['goodsimg'])) {
      const img = resolvePlatformImage(platformGoods, matchedSku);
      if (img !== '') cart['goodsimg'] = img;
    }
    if (isEmptyValue(cart['goodsseller'])) {
      const shopNick = String(
        platformGoods.sellerInfo?.nick ?? platformGoods.sellerInfo?.shopName ?? '',
      );
      if (shopNick !== '') cart['goodsseller'] = shopNick;
    }
    if (!isEmptyValue(cart['sku_name']) && preparedCart.skus.length > 0) return;

    const props = propsFromPlatformSku(matchedSku, platformGoods.propsList ?? {});
    if (props.length === 0) return;
    preparedCart.skus = props;
    preparedCart.goodsInfo = { ...preparedCart.goodsInfo, props };
    cart['sku_name'] = formatSkuNameHtml(props);
  }

  /** 旧 fetchPlatformGoodsInfoForVerify（按 site:goodsId:miId 缓存 null 结果） */
  async fetchPlatformGoodsInfoForVerify(
    cart: Record<string, unknown>,
    ctx: { goodsInfoCache: Map<string, PlatformGoodsInfo | null> },
  ): Promise<PlatformGoodsInfo | null> {
    const goodsId = String(cart['goodsid'] ?? '');
    const goodsSite = String(cart['goodssite'] ?? '');
    const miId = String(cart['miId'] ?? '');
    const cacheKey = `${goodsSite}:${goodsId}:${miId}`;
    if (ctx.goodsInfoCache.has(cacheKey)) return ctx.goodsInfoCache.get(cacheKey) ?? null;

    let info: PlatformGoodsInfo | null = null;
    try {
      info = await this.deps.platformGoods.fetch({ goodsSite, goodsId, miId });
      // 1688：status 必须 published，否则视为下架
      if (info && goodsSite === GOODS_SITE_1688 && info.status !== 'published') info = null;
      if (info && isEmptyValue(info.title)) info = null;
    } catch {
      info = null;
    }
    ctx.goodsInfoCache.set(cacheKey, info);
    return info;
  }

  // -------------------------------------------------------------------------
  // 旧 assertProductMinOrderQuantity
  // -------------------------------------------------------------------------

  async collectBelowMinOrderQuantity(
    preparedCarts: PreparedCart[],
    ctx: { goodsInfoCache: Map<string, PlatformGoodsInfo | null> },
  ): Promise<MinOrderLine | null> {
    const products = new Map<string, MinOrderLine>();
    for (const preparedCart of preparedCarts) {
      const line = await this.productMinOrderLine(preparedCart, ctx);
      if (!line) continue;
      const existing = products.get(line.key);
      if (existing) {
        existing.quantity += line.quantity;
        existing.amount += line.amount;
        if (line.min > existing.min) existing.min = line.min;
      } else {
        products.set(line.key, { ...line });
      }
    }
    return findBelowMinOrderQuantity([...products.values()]);
  }

  async productMinOrderLine(
    preparedCart: PreparedCart,
    ctx: { goodsInfoCache: Map<string, PlatformGoodsInfo | null> },
  ): Promise<MinOrderLine | null> {
    const cart = preparedCart.cart;
    const goodsSite = String(cart['goodssite'] ?? '');
    if (goodsSite !== GOODS_SITE_TAOBAO && goodsSite !== GOODS_SITE_1688) return null;
    const goodsId = String(cart['goodsid'] ?? '');
    if (goodsId === '') return null;

    const platform = await this.fetchPlatformGoodsInfoForVerify(cart, ctx);
    const min = resolveMinOrderQuantity(platform, preparedCart.goodsInfo);
    if (min < 1) return null;

    const mix = mixRule(platform, preparedCart.goodsInfo);
    const quantity = Math.trunc(Number(cart['goodsnum'] ?? 0));
    const price = Number(cart['goodsprice'] ?? 0);
    return {
      key: `${goodsSite}:${goodsId}`,
      title: String(cart['goodsname'] ?? goodsId),
      quantity,
      amount: price * quantity,
      min,
      shopKey: shopKey(platform, goodsSite, goodsId),
      hasMix: mix !== null,
      mix,
    };
  }

  // -------------------------------------------------------------------------
  // 旧 handleSkuDuplication
  // -------------------------------------------------------------------------

  async handleSkuDuplication(
    preparedCarts: PreparedCart[],
    ctx: { uid: number },
    isValidate: number | null,
  ): Promise<PreparedCart[]> {
    // 兼容老接口：isValidate 为空（null/0/未传）→ 跳过校验与合并
    if (!isValidate) return preparedCarts;

    const goodsIds: string[] = [];
    const newCartSkuHashes = new Map<
      string,
      {
        preparedCart: PreparedCart;
        index: number;
        duplicatedCarts: Array<{ gid: number; goodsnum: number }>;
      }
    >();

    for (const preparedCart of preparedCarts) {
      const cart = preparedCart.cart;
      if (isEmptyValue(cart['goodsid'])) continue;
      if (String(cart['goodssite'] ?? '') === GOODS_SITE_ZHUANYUN) continue; // 转运加购不合并
      const goodsId = String(cart['goodsid']);
      goodsIds.push(goodsId);
      const skuHash = generateSkuAttrsHash(preparedCart.skus);
      newCartSkuHashes.set(`${goodsId}_${skuHash}`, {
        preparedCart,
        index: preparedCart.index,
        duplicatedCarts: [],
      });
    }
    if (goodsIds.length === 0) return preparedCarts;

    const existingCarts = await this.deps.repository.listCartsByGoodsIds(
      this.deps.repository.db,
      ctx.uid,
      [...new Set(goodsIds)],
    );
    for (const existing of existingCarts) {
      const existingSkuHash = generateSkuAttrsHash(parseSkuAttrsFromCart(existing.sku_name));
      const key = `${String(existing.goodsid ?? '')}_${existingSkuHash}`;
      const entry = newCartSkuHashes.get(key);
      if (!entry) continue;
      // 额外信息（17 列）全等才合并；校验模式的返回 gids 分支在旧代码里已注释掉（死代码）
      if (
        compareExtraFields(existing as unknown as Record<string, unknown>, entry.preparedCart.cart)
      ) {
        entry.duplicatedCarts.push({ gid: existing.gid, goodsnum: existing.goodsnum ?? 0 });
      }
    }

    if (isValidate === 2) {
      for (const entry of newCartSkuHashes.values()) {
        if (entry.duplicatedCarts.length > 0) {
          preparedCarts[entry.index]!.duplicatedCarts = entry.duplicatedCarts;
        }
      }
    }
    return preparedCarts;
  }

  // -------------------------------------------------------------------------
  // 旧 assertCartCountWithinLimit
  // -------------------------------------------------------------------------

  async assertCartCountWithinLimit(
    finalPreparedCarts: PreparedCart[],
    ctx: { uid: number; isDf: boolean },
    isValidate: number | null,
  ): Promise<OrderError | null> {
    const maxCount = this.deps.cartMaxCount;
    if (maxCount <= 0) return null;

    const types = ctx.isDf ? [ORDER_TYPE.DAIFA] : [ORDER_TYPE.DAIGOU, ORDER_TYPE.ZHUANYUN];
    const currentCount = await this.deps.repository.countUserCarts(
      this.deps.repository.db,
      ctx.uid,
      types,
    );

    let delta = 0;
    for (const preparedCart of finalPreparedCarts) {
      if (
        isValidate === 2 &&
        preparedCart.duplicatedCarts &&
        preparedCart.duplicatedCarts.length > 0
      ) {
        delta += 1 - preparedCart.duplicatedCarts.length;
      } else {
        delta += 1;
      }
    }

    if (currentCount + delta > maxCount) {
      return {
        code: 'CART_MAX_COUNT_REACHED',
        message: orderError('CART_MAX_COUNT_REACHED').message.replace(
          ':maxCount',
          String(maxCount),
        ),
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 旧 bugAgainVerifyProducts（再买一单 add_from=6）
  // -------------------------------------------------------------------------

  /** @returns 跳转 URL（多规格回详情页）；null = 无需跳转 */
  async bugAgainVerifyProducts(
    preparedCarts: PreparedCart[],
    ctx: { uid: number; isDf: boolean; goodsInfoCache: Map<string, PlatformGoodsInfo | null> },
  ): Promise<string | null> {
    const repurchaseCarts = preparedCarts.filter(
      (p) => Number(p.goodsInfo.addFrom ?? 0) === ADD_FROM_REPURCHASE,
    );
    if (repurchaseCarts.length === 0) return null;

    const platformCarts: PreparedCart[] = [];
    for (const preparedCart of repurchaseCarts) {
      const goodsSite = String(preparedCart.cart['goodssite'] ?? '');
      if (goodsSite !== GOODS_SITE_TAOBAO && goodsSite !== GOODS_SITE_1688) continue;
      // 淘宝/1688 解析不出 goodsid = 平台链接已失效 → 下架（旧 :740-743）
      if (isEmptyValue(preparedCart.cart['goodsid'])) throw orderError('CART_GOODS_OFF_SHELF');
      platformCarts.push(preparedCart);
    }
    if (platformCarts.length === 0) return null;

    const goodsIds = [...new Set(platformCarts.map((p) => String(p.cart['goodsid'] ?? '')))];
    if (platformCarts.length > 1 && goodsIds.length > 1) {
      throw orderError('CART_GOODS_URL_MISMATCH');
    }

    const baseCart = platformCarts[0]!.cart;
    const goodsInfo = await this.fetchPlatformGoodsInfoForVerify(baseCart, ctx);
    if (!goodsInfo) throw orderError('CART_GOODS_OFF_SHELF');

    const skus = goodsInfo.skus ?? [];
    if (skus.length <= 1) return null;

    const skuQuantityMap = new Map<string, number>();
    const skuCartMap = new Map<string, Record<string, unknown>>();
    for (const preparedCart of platformCarts) {
      const skuId = String(preparedCart.cart['shangpin_sku'] ?? '');
      const quantity = Math.trunc(Number(preparedCart.cart['goodsnum'] ?? 0));
      if (!skuQuantityMap.has(skuId)) {
        skuQuantityMap.set(skuId, 0);
        skuCartMap.set(skuId, {
          ...preparedCart.cart,
          props: preparedCart.goodsInfo.props ?? null,
        });
      }
      skuQuantityMap.set(skuId, (skuQuantityMap.get(skuId) ?? 0) + quantity);
    }

    const items = buildRepurchaseItems(
      [...skuQuantityMap.keys()],
      [...skuQuantityMap.values()],
      [...skuQuantityMap.keys()].map((k) => skuCartMap.get(k) ?? {}),
    );
    return this.buildProductFrontendUrl(baseCart, goodsInfo, items, ctx.isDf);
  }

  /** 旧 buildProductFrontendUrl（1688 / 淘宝两条路径 + repurchaseItems 查询串） */
  buildProductFrontendUrl(
    cart: Record<string, unknown>,
    goodsInfo: PlatformGoodsInfo | null,
    repurchaseItems: Array<Record<string, unknown>>,
    isDf: boolean,
  ): string {
    const goodsId = String(cart['goodsid'] ?? '');
    const goodsSite = String(cart['goodssite'] ?? '');
    let productUrl = String(cart['goodsurl'] ?? '');
    const detailUrl = String(goodsInfo?.detailUrl ?? '');

    let path: string;
    if (goodsSite === GOODS_SITE_1688) {
      if (productUrl === '')
        productUrl = detailUrl !== '' ? detailUrl : `https://detail.1688.com/offer/${goodsId}.html`;
      path = `product/1688/${goodsId}.html?productUrl=${encodeURIComponent(productUrl)}&serviceType=0`;
    } else {
      if (productUrl === '') productUrl = detailUrl;
      if (productUrl === '') {
        const miId = String(cart['miId'] ?? '');
        productUrl = `https://item.taobao.com/item.htm?id=${goodsId}`;
        if (miId !== '') productUrl += `&mi_id=${encodeURIComponent(miId)}`;
      }
      path = `product/taobao/${goodsId}.html?productUrl=${encodeURIComponent(productUrl)}&serviceType=1`;
    }

    if (repurchaseItems.length > 0) {
      path += `&${REPURCHASE_ITEMS_QUERY_KEY}=${encodeURIComponent(JSON.stringify(repurchaseItems))}`;
    }
    return this.deps.frontendUrl.build(path, isDf);
  }

  // -------------------------------------------------------------------------
  // 旧 1688 店铺映射 + getProduct
  // -------------------------------------------------------------------------

  /** 旧 :286-336：1688 且 add_from∈{1,2} 时反解店铺名并维护映射 */
  async resolveAlibabaShopSeller(preparedCart: PreparedCart): Promise<void> {
    const goodsInfo = preparedCart.goodsInfo;
    const cart = preparedCart.cart;
    if (goodsInfo.platform !== '1688' || ![1, 2].includes(Number(goodsInfo.addFrom ?? -1))) return;

    const sellerOpenId = await this.deps.alibabaShop.searchShopNameByGoodsId(
      String(cart['goodsid'] ?? ''),
    );
    if (!sellerOpenId) return;

    let shop = await this.deps.supplierShop.findByOpenId(
      this.deps.alibabaFenxiaoAppid,
      sellerOpenId,
    );
    if (!shop && !isEmptyValue(cart['goodsseller'])) {
      shop = await this.deps.supplierShop.create(
        this.deps.alibabaFenxiaoAppid,
        sellerOpenId,
        String(cart['goodsseller']),
      );
    }
    if (!shop) return;

    let nickname = shop.nickname;
    if (isEmptyValue(nickname)) {
      const sellerName = await this.deps.alibabaShop.decryptOpenidFromFenxiaoApi(sellerOpenId);
      if (sellerName) nickname = sellerName;
    }

    let title: string = shop.title;
    // 清洗：title 与 nickname/openid 相同 → 置空（历史脏数据的清洗，旧代码原话）
    if (title !== null && title !== '' && (title === nickname || title === sellerOpenId))
      title = '';
    // title 为空且传入的店铺名既不是 openid 也不是昵称 → 用传入值补
    if (!isEmptyValue(cart['goodsseller']) && isEmptyValue(title)) {
      const incoming = String(cart['goodsseller']);
      if (incoming !== sellerOpenId && incoming !== nickname) title = incoming;
    }

    shop = await this.deps.supplierShop.update(shop.id, { title, nickname });
    cart['goodsseller'] = isEmptyValue(shop.title) ? shop.nickname : shop.title;
  }

  /** 旧 getProduct：淘宝/1688 且 goodsid 非空才解析，否则 null（→ supplier_product_id = 0） */
  async getProduct(preparedCart: PreparedCart): Promise<{ id: number } | null> {
    const cart = preparedCart.cart;
    const goodsSite = String(cart['goodssite'] ?? '');
    const platforms: Record<string, string> = {
      [GOODS_SITE_TAOBAO]: PRODUCT_PLATFORM_TAOBAO,
      [GOODS_SITE_1688]: PRODUCT_PLATFORM_1688,
    };
    if (!platforms[goodsSite]) return null;
    // 旧 TODO 兼容：goodsid 为空直接 null
    if (isEmptyValue(cart['goodsid'])) return null;

    return this.deps.supplierProduct.resolveOrCreate({
      platform: platforms[goodsSite]!,
      goodsId: String(cart['goodsid']),
      shopId: 0, // 旧 `$platformShop->id ?? 0`（R1 端口未返回店铺行，恒 0）
      goodsUrl: String(cart['goodsurl'] ?? ''),
      goodsName: String(cart['goodsname'] ?? ''),
      imgUrl: String(cart['goodsimg'] ?? ''),
      price: Number(cart['goodsprice'] ?? 0),
      priceRange: parsePriceRangeJson(preparedCart.goodsInfo.priceRange),
      minOrderQuantity: Math.trunc(Number(preparedCart.goodsInfo.minOrderQuantity ?? 1)),
      onePieceFreePostage: Math.trunc(Number(preparedCart.goodsInfo.onePieceFreePostage ?? 0)),
      sellerMixSetting: parseSellerMixSetting(preparedCart.goodsInfo.sellerMixSetting),
    });
  }
}

/** 旧 buildRepurchaseItems：只带非空值（数组原样、标量转字符串） */
export function buildRepurchaseItems(
  skuIds: string[],
  quantities: number[],
  skuCarts: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const extraFields = [
    'goodsremark',
    'yanhuofba',
    'yanhuoasin',
    'yanhuofnsku',
    'outid',
    'props',
    'var1',
    'var2',
    'var3',
    'var4',
    'var5',
    'var6',
    'var7',
    'var8',
    'var9',
    'var10',
    'var11',
    'var12',
  ];
  const items: Array<Record<string, unknown>> = [];
  for (let i = 0; i < skuIds.length; i += 1) {
    const skuCart = skuCarts[i] ?? {};
    const item: Record<string, unknown> = { skuId: skuIds[i], quantity: quantities[i] };
    for (const field of extraFields) {
      const value = skuCart[field];
      if (
        value === null ||
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
      )
        continue;
      item[field] = Array.isArray(value) ? value : String(value);
    }
    items.push(item);
  }
  return items;
}

/** 旧 getPriceRange：必须是非空数组，且每项同时含 price 与 startQuantity */
export function parsePriceRangeJson(
  raw: string | null | undefined,
): Array<{ price: unknown; startQuantity: unknown }> | null {
  if (!raw) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length === 0) return null;
  for (const item of decoded) {
    if (typeof item !== 'object' || item === null) return null;
    if (!('price' in item) || !('startQuantity' in item)) return null;
  }
  return decoded as Array<{ price: unknown; startQuantity: unknown }>;
}

/** 旧 `empty($x) ? null : json_decode($x, true)` */
function parseSellerMixSetting(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** PHP empty() 对字符串/null/undefined/0 的近似（本文件只用于字符串列） */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === 0 || value === '0';
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 旧 UserError → Result 化的类型守卫 */
function isOrderError(e: unknown): e is OrderError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}
