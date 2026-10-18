import { createHash } from 'node:crypto';
import { shanghaiWallClock } from '@crossbuy/utils';
import { money, moneyEquals, moneyOf } from './money';
import {
  computePriceBaseline,
  extractAlibabaAmounts,
  summarizeAmountCalculationOrders,
} from './amount-baseline';
import { DeferredAmountSync, migrateAmountCarrier, resolveAmountCarrier } from './amount-sync';
import type { ChromeOrderRow, Db, OrderRepository } from './repository';

/**
 * chrome 插件回传（旧 `OrderController::webhookForChrome` 的校验/保存主体 1:1）。
 *
 * 旧代码是一个 2756 行控制器，本文件只复现**回传四动作**里的三个：
 *   ACTION_VALIDATE(1)      → validateOrderByOidAndTradeId
 *   ACTION_SAVE(2)          → validateAndSave
 *   ACTION_MODIFY_ORDER(5)  → validateAndSave（拼凑版订单详情）
 * 其余动作：SAVE_EXPRESS(4) 在 shipment.ts（已完成）；GET(3)/GET_STATE_PAID(7)/
 * CREATE_1688_ORDER(8) 属后台采购面，登记 TODO(#18) 未迁移。
 *
 * 1:1 纪律（每条都对应旧代码的**异常**行为，禁"顺手修"）：
 * - `order_detail.action` 才是分支判据（`Arr::get($extra,'order_detail.action')`），
 *   与信封上的 `action` 不是同一个来源——插件两个值不一致时以 order_detail 为准。
 * - 砍价基线 = `goodsTotal + **平台**运费`（DB 运费只出现在拦截文案与风控日志里）。
 * - 1688 红包 `couponFee` 先加回 `totalAmount` 再当实付（红包抵扣也算砍价）。
 * - `skip_price_check` 可整体旁路单价/数量/负砍价三道守卫（旧后门，registry S44）。
 * - 单测覆盖的纯函数（sku 匹配、金额基线）与 DB 用例（载体迁移、写库列）分离，
 *   与 add-cart 切片同构。
 */

// ---------------------------------------------------------------------------
// 旧常量（OrderController 1:1）
// ---------------------------------------------------------------------------

/** 旧 `TYPE_1688` / `TYPE_TAOBAO`（`TYPE_TAOBAO_GLOBAL` 与 TAOBAO 同值 2） */
export const CHROME_TRADE_TYPE = { ALIBABA: 1, TAOBAO: 2 } as const;

/** 旧 `ACTION_*` */
export const CHROME_ACTION = {
  VALIDATE: 1,
  SAVE: 2,
  GET: 3,
  SAVE_EXPRESS: 4,
  MODIFY_ORDER: 5,
  MODIFY_ORDER_BY_API: 6,
  GET_STATE_PAID: 7,
  CREATE_1688_ORDER: 8,
} as const;

/** 旧 `Order::$finalStates`（已返金 10 / 已废弃 11）——**不含 6**（无效未返金可编辑） */
const FINAL_STATES: readonly number[] = [10, 11];

/** 旧 `BatchUpdateOrder::$fieldsToUpdate` 里 saveOrderInfo 用到的四项（radio 1/4/9/14） */
export const CHROME_EDIT_FIELDS = ['tid', 'bargainprice', 'sendprice', 'couponFee'] as const;

/** 旧 `PURCHASE_TYPE_MANUAL`（手动填写 tid = 手动下单） */
const PURCHASE_TYPE_MANUAL = 1;

/** 旧 `$defaultSpecId = 'default_key'` */
const DEFAULT_SPEC_ID = 'default_key';

/** 结果信封（旧控制器直接回数组：code 200 / 40000） */
export type ChromeResult =
  | { code: 200; data?: ChromeValidateData }
  | { code: 40000; msg: string | null; oids?: string[]; order?: unknown; data?: unknown };

/** 旧 `validateOrderByOidAndTradeId` 成功返回的 data（字段名 1:1，金额为字符串） */
export interface ChromeValidateData {
  trade_parent_id: string;
  post_fee: string;
  real_pay: string;
  bargainprice: string;
  items: ChromeValidatedItem[];
  coupon_fee: string;
}

/** 旧 `$itemInfo[$uniqueKey]` 形态 */
export interface ChromeValidatedItem {
  offerId: string;
  name: string;
  specId?: string | null;
  quantity: number;
  /** 后台单价（旧 `$order->goodsprice`） */
  price: number;
  /** 实际单价（旧 `$skuDetail['price']`，可能被砍后单价修正） */
  real_price: number;
  /** 实际付款金额（旧 `$skuDetail['itemAmount']`） */
  real_pay: number;
  sku_info: Record<string, string>;
  ids: number[];
}

/** 平台订单商品项（旧 `$orderDataFromApi['productItems']` / 淘宝构造的同形结构） */
export interface PlatformProductItem {
  productID?: string | number;
  specId?: string | null;
  name?: string;
  quantity?: number | string;
  price?: number | string;
  itemAmount?: number | string;
  skuInfos?: Array<{ name?: string; value?: string } | null> | null;
  /** 旧「后台订单中未包含」报错文案读的是 **sku_info**（单数）——生产数据无此键，恒空串（S45） */
  sku_info?: Array<{ name?: string; value?: string }> | null;
  [key: string]: unknown;
}

/** 归一化后的平台订单（旧 `$orderDataFromApi`） */
export interface NormalizedPlatformOrder {
  shippingFee: number;
  totalAmount: number;
  couponFee: number;
  productItems: PlatformProductItem[];
}

/** chrome 插件信封里的 order_detail（多形态共存，1:1 旧 `is_string ? json_decode : 原样`） */
export type ChromeOrderDetail = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 文本工具（旧 removeTags / trim / html_entity_decode 的等价物）
// ---------------------------------------------------------------------------

/** PHP `trim()` 默认字符集：空格 / \t / \n / \r / \0 / \v（**不含** \f 与全角空格） */
const PHP_TRIM_CHARS: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\0', '\v']);

/** 旧 `trim($v)` 1:1（手写扫描而非正则：正则里的控制字符会触发 no-control-regex） */
export function phpTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PHP_TRIM_CHARS.has(value[start]!)) start += 1;
  while (end > start && PHP_TRIM_CHARS.has(value[end - 1]!)) end -= 1;
  return value.slice(start, end);
}

/**
 * 旧 `OrderController::removeTags` 1:1（顺序敏感：`&nbsp;` 先变空格，`;` 后删，
 * `"` 才变 `&quot;`——换顺序结果就不同，见 S46）。
 */
export function removeTags(msg: string): string {
  let out = msg;
  out = out.split('%20').join('');
  out = out.split('%27').join('');
  out = out.split('*').join('');
  out = out.split('"').join('');
  out = out.split('&amp;').join('&');
  out = out.split('&nbsp;').join(' ');
  out = out.split(';').join('');
  out = out.split('"').join('&quot;');
  out = out.split("'").join('&#039;');
  out = out.split('<').join('&lt;');
  out = out.split('>').join('&gt;');
  out = out.split('(').join('');
  out = out.split(')').join('');
  out = out.split('{').join('');
  out = out.split('}').join('');
  out = out.split('\t').join('   &nbsp;  &nbsp;');
  out = out.split('\r').join('');
  return out.split('   ').join(' &nbsp; ');
}

/** 旧 `htmlspecialchars_decode` + `html_entity_decode`（只覆盖实体子集：旧逻辑等价面） */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#0*38;/g, '&')
    .replace(/&nbsp;/gi, '\u00a0')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&');
}

/** 旧 `searchSkuDetail` 的取值归一化（removeTags → 去非字母/汉字/数字 → 去空格/&nbsp;/Â ） */
export function normalizeSkuValue(value: string): string {
  let out = removeTags(value);
  out = out.replace(/[^a-zA-Z\p{Script=Han}\d]/gu, '');
  out = out.split(' ').join('');
  out = out.split('&nbsp;').join('');
  out = out.split('\u00a0').join('');
  return phpTrim(out);
}

/** 旧 `Order::getSkuName()`：sku_name 为空 → 用 goodssize/goodscolor 拼 HTML（尺码在前） */
export function chromeSkuName(
  order: Pick<ChromeOrderRow, 'sku_name' | 'goodssize' | 'goodscolor'>,
): string {
  let skuName = order.sku_name ?? '';
  if (!skuName) {
    if (order.goodssize)
      skuName += `<font color=red>尺码:</font><font color=green>${order.goodssize}</font>`;
    if (order.goodscolor)
      skuName += `<font color=red>颜色:</font><font color=green>${order.goodscolor}</font>`;
  }
  return skuName;
}

/**
 * 旧 `preg_match_all('/<font\s*color=red>(.+?)<.*?><font\s*color=green>(.+?)<.*?>/', $skuName, $matches)`
 * + `array_combine($matches[1], $matches[2])`。
 *
 * ⚠ 与 `list-helpers.parseSkuName`（旧 `Order::parseSkuName`）**不同**：这里没有 `[:：]`，
 * 名字里会带上 `颜色分类:` 的冒号——回传匹配靠 name 精确比对，差一个冒号就匹配不上。
 * 同名规格后者覆盖前者（array_combine 语义）。
 */
export function parseChromeSkuPairs(skuName: string): Record<string, string> | null {
  const re = /<font\s*color=red>(.+?)<.*?><font\s*color=green>(.+?)<.*?>/gu;
  const names: string[] = [];
  const values: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(skuName)) !== null) {
    names.push(m[1] ?? '');
    values.push(m[2] ?? '');
  }
  if (names.length === 0) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i += 1) out[names[i]!] = values[i]!;
  return out;
}

// ---------------------------------------------------------------------------
// sku 解析（旧 searchSkuDetail 1:1，detailType=1 面）
// ---------------------------------------------------------------------------

export type SkuSearchResult =
  { ok: true; detail: PlatformProductItem } | { ok: false; msg: string };

function skuMissMessage(itemId: string): string {
  return `查询商品信息失败，请确认是否漏下或多下，或者采购过程中点击了后台其他订单。若核对订单信息无误，请到后台手动填写或联系开发人员。${itemId}`;
}

/**
 * 旧 `searchSkuDetail($itemId, $items, $expectSku, $type = 1, $detailType = 1)`。
 *
 * `$type` = 匹配宽松度：1 精确 / 2 宽松（去符号比对 value）/ 3 先解码实体再宽松。
 * `$detailType` 三种数据源：1 订单商品项（回传链路用）/ 2 1688 商品详情 / 3 淘宝详情。
 * 回传链路只走 1（1:1），2/3 属 M3 建单面——显式抛错而不是静默走错分支。
 */
export function searchSkuDetail(
  itemId: string,
  items: PlatformProductItem[],
  expectSku: Record<string, string>,
  type = 1,
  detailType = 1,
): SkuSearchResult {
  if (detailType !== 1) {
    throw new Error(
      `searchSkuDetail: detailType=${detailType} 未迁移（M3 淘宝全球购建单面，TODO(#18)）`,
    );
  }

  // 旧 `collect($items)->where('productID', $itemId)`（PHP 松比较：数字/字符串混用）
  const collection = items.filter((item) => String(item.productID ?? '') === itemId);
  if (collection.length === 0) return { ok: false, msg: skuMissMessage(itemId) };

  if (Object.keys(expectSku).length === 0) {
    return { ok: false, msg: 'sku 信息为空，请联系管理员处理。' };
  }

  // 报错文案里的期望 sku 串（旧代码在归一化**之前**拼）
  let expectSkuName = '';
  for (const [name, value] of Object.entries(expectSku)) {
    expectSkuName += `${phpTrim(phpTrim(name))}${phpTrim(value)}`;
  }

  const relaxed = type === 2 || type === 3;
  let errorMsg = '';

  const matched = collection.filter((value) => {
    if (!value.skuInfos || value.skuInfos.length === 0) {
      errorMsg = `无法识别以下 sku 信息，请到后台手动填写下单信息，无法识别内容：${itemId} ${expectSkuName}。`;
      return false;
    }

    let attributes = value.skuInfos
      .filter((a): a is { name?: string; value?: string } => a !== null && a !== undefined)
      .map((a) => ({ name: String(a.name ?? ''), value: String(a.value ?? '') }));

    if (relaxed) {
      attributes = attributes.map((a) => ({ ...a, value: normalizeSkuValue(a.value) }));
    }

    if (attributes.length !== Object.keys(expectSku).length) {
      errorMsg = `用户下单的 sku 数量和官方返回的不一致，请核对您的下单是否正确或联系开发人员排查：${itemId} ${expectSkuName}`;
      return false;
    }

    for (const [rawName, rawValue] of Object.entries(expectSku)) {
      const name = phpTrim(phpTrim(rawName).replace(/^:+|:+$/g, ''));
      let value = phpTrim(rawValue);

      if (relaxed) {
        if (type === 3) value = decodeHtmlEntities(value);
        value = normalizeSkuValue(value);
      }

      let data = attributes.find((a) => a.name === name && a.value === value);
      if (!data) {
        if (/\s/u.test(value)) {
          const plus = value.split(' ').join('+');
          data = attributes.find((a) => a.name === name && a.value === plus);
          if (!data) {
            data = attributes.find((a) => a.value === plus);
            if (!data) return false;
          }
        } else {
          data = attributes.find((a) => a.value === value);
          if (!data) return false;
        }
      }
    }
    return true;
  });

  if (errorMsg !== '') return { ok: false, msg: errorMsg };

  if (matched.length > 1) {
    return {
      ok: false,
      msg: `下单信息中存在重复规格的商品，请核对您的下单是否正确或联系开发人员排查：${itemId} ${expectSkuName}`,
    };
  }
  if (matched.length === 1) return { ok: true, detail: matched[0]! };
  return {
    ok: false,
    msg: `下单信息中缺少以下规格商品，请核对是否漏下或联系开发人员排查：${itemId} ${expectSkuName}`,
  };
}

// ---------------------------------------------------------------------------
// 淘宝订单详情 → 归一化平台订单（旧 validateOrderByOidAndTradeId 的 2 个 JSON 分支）
// ---------------------------------------------------------------------------

/** 旧「拼凑版」分支：`$orderDetail['sub_orders']` → productItems（price/itemAmount 恒 0，S47） */
export function buildProductItemsFromSubOrders(
  subOrders: Array<Record<string, unknown>>,
): PlatformProductItem[] {
  const items: PlatformProductItem[] = [];
  for (const subOrder of subOrders) {
    const title = String(subOrder['name'] ?? '');
    const skuInfosRaw = subOrder['sku_infos'];
    const skuInfos = Array.isArray(skuInfosRaw)
      ? (skuInfosRaw as Array<{ name?: string; value?: string }>)
      : [];

    const item: PlatformProductItem = {
      itemAmount: 0,
      name: title,
      // 旧 `preg_replace('/[^a-zA-Z\p{Script=Han}\d]/u','', $title)`——用标题代替商品 id
      productID: title.replace(/[^a-zA-Z\p{Script=Han}\d]/gu, ''),
      skuInfos,
      price: 0,
      quantity: Number(subOrder['quantity'] ?? 0),
    };
    if (skuInfos.length > 0) {
      // 旧 `md5(json_encode($subOrder['sku_infos']))`
      item.specId = createHash('md5').update(JSON.stringify(skuInfosRaw)).digest('hex');
    }
    items.push(item);
  }
  return items;
}

/** 旧「淘宝订单详情（mainOrders）」分支：赠品（subOrder.id 空）直接跳过 */
export function buildProductItemsFromMainOrders(
  subOrders: Array<Record<string, unknown>>,
): PlatformProductItem[] {
  const items: PlatformProductItem[] = [];
  for (const subOrder of subOrders) {
    if (!subOrder['id']) continue;

    const itemInfo = (subOrder['itemInfo'] ?? {}) as Record<string, unknown>;
    const priceInfo = (subOrder['priceInfo'] ?? {}) as Record<string, unknown>;
    const price = Number(priceInfo['realTotal'] ?? 0);
    const quantity = Number(subOrder['quantity'] ?? 0);
    const skuId = itemInfo['skuId'];

    const item: PlatformProductItem = {
      itemAmount: moneyOf(price * quantity),
      name: String(itemInfo['title'] ?? ''),
      productID: String(itemInfo['id'] ?? ''),
      // 旧 `$skuInfos = $subOrderItem['skuText']`（不是数组也原样塞）
      skuInfos: Array.isArray(itemInfo['skuText'])
        ? (itemInfo['skuText'] as Array<{ name?: string; value?: string }>)
        : [],
      price,
      quantity,
    };
    if (Number(skuId) !== -1) item.specId = `${skuId}`;
    items.push(item);
  }
  return items;
}

/**
 * 旧 `payInfo.postFees.0.value` 的 `^￥([\d\.]+)$` 解析：命中取数字，否则 **0**（不是 null）。
 */
export function parsePostFeeValue(value: unknown): number {
  const m = /^￥([\d.]+)$/.exec(String(value ?? ''));
  return m ? moneyOf(Number(m[1])) : 0;
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/** 后台操作者（旧 `Admin::user()` 的三个字段；payid 用于自动分配采购员） */
export interface ChromeAdminIdentity {
  id: number;
  username: string;
  name: string;
  payid: string;
}

/** 1688 订单详情端口（旧 `resolveAlibabaSdkByTradeId($tradeId)->getOrderDetail()`；SDK 未迁移 ⇒ 返回 null） */
export interface AlibabaOrderDetailPort {
  getOrderDetail(
    tradeId: string,
  ): Promise<{ baseInfo: Record<string, unknown>; productItems: PlatformProductItem[] } | null>;
}

/** chrome 回传入参（信封解出后的形态） */
export interface ChromeWebhookInput {
  /** 旧 `explode(',', $request->input('oids'))` 的原始串 */
  oids: string;
  tradeId: string;
  action: number;
  tradeType: number;
  orderDetail: ChromeOrderDetail | null;
  skipPriceCheck: boolean;
}

export interface ChromeDeps {
  repository: OrderRepository;
  /** 1688 详情端口（SDK 面；未迁移时组合根给恒 null 实现 → 40000「获取订单信息失败」，S48） */
  alibaba: AlibabaOrderDetailPort;
  /** 平台金额快照端口（旧 PlatformOrderAmountSnapshotService::record1688；失败不阻断） */
  recordSnapshot?: (
    tid: string,
    detail: { baseInfo: Record<string, unknown>; productItems: PlatformProductItem[] },
    stage: 'sync' | 'price_modified',
  ) => Promise<void>;
  /** 发货回传（旧 updateExpressNoForChrome；ACTION_SAVE_EXPRESS） */
  shipment?: {
    updateExpressNoForChrome(input: unknown): Promise<{ code: 200 | 40000; msg?: string }>;
  };
  /** 审计日志端口（旧 Log::channel('order_update') + admin_operation_log；R1 默认 no-op） */
  auditLog?: (info: { change: Record<string, unknown>; oids: number[] }) => void;
  /** 风控日志端口（旧 Log::channel('webhook_1688')->warning） */
  riskLog?: (info: Record<string, unknown>) => void;
  runTx: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  now: () => Date;
}

/** 一次回传的上下文（旧 `$extra`） */
export interface ChromeContext {
  input: ChromeWebhookInput;
  oids: number[];
  orderDetail: ChromeOrderDetail;
  /** 旧 `$action = Arr::get($extra,'order_detail.action')`——**不是**信封上的 action */
  detailAction: number | null;
  admin: ChromeAdminIdentity;
}

export class ChromeService {
  private readonly deferredSync = new DeferredAmountSync();

  constructor(protected readonly deps: ChromeDeps) {}

  private get repo(): OrderRepository {
    return this.deps.repository;
  }

  private get db(): Db {
    return this.deps.repository.db;
  }

  private nowSec(): number {
    return Math.floor(this.deps.now().getTime() / 1000);
  }

  /**
   * 旧 `webhookForChrome` 的路由分支（认证在上层：旧 `Admin::user()` → 新系统 admin JWT）。
   * 返回 `null` 表示该 action 未迁移（路由层据此回 40000 并留痕）。
   */
  async handle(input: ChromeWebhookInput, admin: ChromeAdminIdentity): Promise<ChromeResult> {
    const ctx: ChromeContext = {
      ...chromeContextOf(input, admin),
      detailAction: this.readDetailAction(input.orderDetail),
    };

    switch (input.action) {
      case CHROME_ACTION.GET:
        return { code: 40000, msg: 'chrome 订单详情展示未迁移（TODO(#18)）' };
      case CHROME_ACTION.GET_STATE_PAID:
        return { code: 40000, msg: 'chrome 已付款订单查询未迁移（TODO(#18)）' };
      case CHROME_ACTION.CREATE_1688_ORDER:
        return { code: 40000, msg: 'chrome 1688 建单未迁移（TODO(#18)）' };
      default:
        break;
    }

    if (
      input.tradeType !== CHROME_TRADE_TYPE.ALIBABA &&
      input.tradeType !== CHROME_TRADE_TYPE.TAOBAO
    ) {
      return { code: 40000, msg: 'wrong type' };
    }

    switch (input.action) {
      case CHROME_ACTION.SAVE_EXPRESS: {
        if (!this.deps.shipment) return { code: 40000, msg: '发货回传端口未接线' };
        const shipped = await this.deps.shipment.updateExpressNoForChrome({
          tid: String(ctx.orderDetail['tid'] ?? ''),
          expressNo: String(ctx.orderDetail['express_no'] ?? ''),
        });
        return shipped.code === 200 ? { code: 200 } : { code: 40000, msg: shipped.msg ?? null };
      }
      case CHROME_ACTION.VALIDATE:
        return this.validateByOidAndTradeId(ctx);
      case CHROME_ACTION.SAVE:
      case CHROME_ACTION.MODIFY_ORDER:
        return this.validateAndSave(ctx);
      default:
        return { code: 40000, msg: 'wrong action' };
    }
  }

  /** 旧 `Arr::get($extra,'order_detail.action')`（缺省 null） */
  private readDetailAction(orderDetail: ChromeOrderDetail | null): number | null {
    if (!orderDetail) return null;
    const raw = orderDetail['action'];
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // -------------------------------------------------------------------------
  // 平台订单归一化
  // -------------------------------------------------------------------------

  /** 旧 validateOrderByOidAndTradeId 的 `switch ($type)`（淘宝两分支 + 1688 SDK 分支） */
  private async loadPlatformOrder(
    ctx: ChromeContext,
  ): Promise<NormalizedPlatformOrder | ChromeResult> {
    const { input, orderDetail, detailAction } = ctx;
    const tradeId = input.tradeId;

    if (input.tradeType === CHROME_TRADE_TYPE.ALIBABA) {
      const detail = await this.deps.alibaba.getOrderDetail(tradeId);
      // 旧 `!isSuccess($orderDataFromApi)` → 原样返回（SDK 的错误信封）
      if (!detail) return { code: 40000, msg: '获取订单信息失败。' };

      // 旧 record1688((string)$tradeId, (array)$data, action∈{5,6} ? 'price_modified' : 'sync')
      await this.deps.recordSnapshot?.(
        tradeId,
        detail,
        detailAction === CHROME_ACTION.MODIFY_ORDER ||
          detailAction === CHROME_ACTION.MODIFY_ORDER_BY_API
          ? 'price_modified'
          : 'sync',
      );

      // 旧「红包加回 totalAmount」（含 logMessage「检测到 1688 平台红包下单更新砍价」）
      const amounts = extractAlibabaAmounts(detail.baseInfo);
      return {
        shippingFee: amounts.shippingFee,
        totalAmount: amounts.totalAmount,
        couponFee: amounts.couponFee,
        productItems: detail.productItems,
      };
    }

    if (detailAction === CHROME_ACTION.MODIFY_ORDER_BY_API) {
      // 旧分支要 `$extra['sdk']`（淘宝全球购 SDK 详情）——chrome 面进不来，M3 随 SDK 迁移
      return { code: 40000, msg: '淘宝全球购 API 改单未迁移（M3，TODO(#18)）' };
    }

    if (detailAction === CHROME_ACTION.MODIFY_ORDER) {
      // 拼凑版订单详情：`$orderDetail['sub_orders']`
      const subOrders = orderDetail['sub_orders'];
      if (!Array.isArray(subOrders) || subOrders.length === 0) {
        return { code: 40000, msg: '获取淘宝订单详情失败。' };
      }
      const realPay = moneyOf(Number(orderDetail['real_pay'] ?? 0));
      const sendPrice = orderDetail['send_price'];
      return {
        shippingFee: sendPrice === undefined || sendPrice === null ? 0 : moneyOf(Number(sendPrice)),
        totalAmount: realPay,
        couponFee: 0,
        productItems: buildProductItemsFromSubOrders(subOrders as Array<Record<string, unknown>>),
      };
    }

    // 淘宝订单详情（mainOrders 版）
    const mainOrders = orderDetail['mainOrders'];
    const first = Array.isArray(mainOrders)
      ? (mainOrders[0] as Record<string, unknown> | undefined)
      : undefined;
    if (!first) return { code: 40000, msg: '获取淘宝订单详情失败。' };

    const realTradeId = String(first['id'] ?? '');
    if (realTradeId !== tradeId) {
      return {
        code: 40000,
        msg: `校验失败，检测到不同的订单号，请联系开发者处理。请确认：${realTradeId} ${tradeId}。`,
      };
    }

    const payInfo = (first['payInfo'] ?? {}) as Record<string, unknown>;
    const postFees = Array.isArray(payInfo['postFees'])
      ? (payInfo['postFees'] as Array<Record<string, unknown>>)
      : [];
    return {
      shippingFee: parsePostFeeValue(postFees[0]?.['value']),
      totalAmount: moneyOf(Number(payInfo['actualFee'] ?? 0)),
      couponFee: 0,
      productItems: buildProductItemsFromMainOrders(
        Array.isArray(first['subOrders'])
          ? (first['subOrders'] as Array<Record<string, unknown>>)
          : [],
      ),
    };
  }

  // -------------------------------------------------------------------------
  // 旧 validateOrderByOidAndTradeId
  // -------------------------------------------------------------------------

  async validateByOidAndTradeId(ctx: ChromeContext): Promise<ChromeResult> {
    const orders = await this.repo.listOrdersForChrome(this.db, ctx.oids);
    if (orders.length === 0) {
      return { code: 40000, oids: ctx.input.oids.split(','), msg: '获取订单信息失败。' };
    }

    const loaded = await this.loadPlatformOrder(ctx);
    if ('code' in loaded) return loaded;
    const platform = loaded;

    const amountSummary = summarizeAmountCalculationOrders(orders);
    if (amountSummary.orders.length === 0) {
      return { code: 40000, msg: '该订单组没有有效订单，无法更新金额' };
    }

    const goodsTotal = amountSummary.goodsTotal;
    const postFee = moneyOf(platform.shippingFee);
    const dbSendPrice = amountSummary.sendpriceTotal;
    const totalMoney = moneyOf(goodsTotal + postFee);
    const orderPaid = platform.totalAmount;
    const kanjia = moneyOf(totalMoney - orderPaid);
    const couponFee = platform.couponFee;

    const items = platform.productItems;

    // 旧 `$skipPriceCheck = Arr::get($extra, 'skip_price_check', false)`
    const skipPriceCheck = ctx.input.skipPriceCheck;
    const action = ctx.detailAction;
    const itemInfo = new Map<string, ChromeValidatedItem>();
    const type = ctx.input.tradeType;

    if (action !== CHROME_ACTION.MODIFY_ORDER_BY_API) {
      for (const order of orders) {
        // 旧 `preg_replace("/(&nbsp;)/", '', $skuName)`——只去这个字面量
        const skuName = chromeSkuName(order).split('&nbsp;').join('');
        let itemId = String(order.goodsid ?? '');
        const pairs = parseChromeSkuPairs(skuName);
        // 拼凑版订单用标题代替 id（旧 `preg_replace('/[^a-zA-Z\p{Script=Han}\d]/u','', $goodsname)`）
        if (action === CHROME_ACTION.MODIFY_ORDER)
          itemId = String(order.goodsname ?? '').replace(/[^a-zA-Z\p{Script=Han}\d]/gu, '');

        let detail: PlatformProductItem;
        let uniqueKey: string;

        if (pairs) {
          // 旧三级宽松匹配：精确 → 宽松 → 解码后宽松
          let skuResult = searchSkuDetail(itemId, items, pairs, 1);
          if (!skuResult.ok) skuResult = searchSkuDetail(itemId, items, pairs, 2);
          if (!skuResult.ok) skuResult = searchSkuDetail(itemId, items, pairs, 3);
          if (!skuResult.ok) return { code: 40000, msg: skuResult.msg };

          detail = skuResult.detail;
          uniqueKey = `${itemId}_${detail.specId ?? ''}`;
        } else {
          if (skuName !== '') {
            return {
              code: 40000,
              msg: `无法识别以下 sku 信息，请到后台手动填写下单信息，无法识别内容：${itemId} ${skuName}。`,
            };
          }

          // 商品没有型号：productID 唯一命中才继续
          const matchedItems = items.filter((item) => String(item.productID ?? '') === itemId);
          if (matchedItems.length !== 1) {
            return {
              code: 40000,
              msg: `无法识别以下 sku 信息，请到后台手动填写下单信息，无法识别内容：${itemId} ${skuName}`,
              order: matchedItems,
            };
          }
          detail = matchedItems[0]!;
          uniqueKey = `${itemId}_${DEFAULT_SPEC_ID}`;
        }

        // 旧：聚合（同 key 累加数量）→ 每次迭代都重写单价/实价/实付/sku_info → 追加 oid
        const entry = this.ensureItem(itemInfo, uniqueKey, itemId, detail, order);
        const skuInfo: Record<string, string> = {};
        for (const attr of detail.skuInfos ?? []) {
          if (!attr) continue;
          skuInfo[String(attr.name ?? '')] = String(attr.value ?? '');
        }
        entry.price = order.goodsprice;
        entry.real_price = Number(detail.price ?? 0);
        entry.real_pay = Number(detail.itemAmount ?? 0);
        entry.sku_info = pairs ? skuInfo : {};
        entry.ids.push(order.oid);

        const priceError = this.correctAndCheckPrice(
          entry,
          detail,
          order,
          type,
          action,
          skipPriceCheck,
        );
        if (priceError) return { code: 40000, msg: priceError };
      }
    }

    // 旧「检测销量」：后台 goodsnum 之和 vs 平台 quantity 之和（**含无效态后台行**）
    const oldQuantity = orders.reduce((acc, o) => acc + (o.goodsnum ?? 0), 0);
    const newQuantity = items.reduce((acc, it) => acc + Number(it.quantity ?? 0), 0);
    if (!skipPriceCheck && oldQuantity !== newQuantity) {
      return {
        code: 40000,
        msg: `实际下单的商品数量与后台中期望值不一致，建议排查。后台：${oldQuantity} 实际下单：${newQuantity}`,
      };
    }

    if (action !== CHROME_ACTION.MODIFY_ORDER_BY_API) {
      // 旧「后台订单中未包含以下商品」
      for (const productionItem of items) {
        const specId = productionItem.specId ?? DEFAULT_SPEC_ID;
        const productId = String(productionItem.productID ?? '');
        const uniqueKey = `${productId}_${specId}`;
        if (itemInfo.has(uniqueKey)) continue;

        let skuDesc = '';
        if (Array.isArray(productionItem.sku_info)) {
          for (const item of productionItem.sku_info) skuDesc += `${item.name}：${item.value}`;
        }
        return {
          code: 40000,
          msg: `后台订单中未包含以下商品，请确认是否多下或错下，若无问题请手动填写订单信息：${productId} ${skuDesc}`,
        };
      }
    }

    if (!skipPriceCheck && kanjia < 0) {
      const baseline = computePriceBaseline({
        goodsTotal,
        dbSendPrice,
        platformSendPrice: postFee,
        realPay: orderPaid,
      });
      this.deps.riskLog?.({
        channel: 'webhook_1688',
        message: '1688 validate order blocked by risk control',
        tid: ctx.input.tradeId,
        action,
        ...baseline.riskLog,
      });
      return {
        code: 40000,
        msg: baseline.blockMessage ?? '实际付款不能大于当前本地价格基线，已阻断自动改价。',
      };
    }

    return {
      code: 200,
      data: {
        trade_parent_id: ctx.input.tradeId,
        post_fee: String(postFee),
        real_pay: String(orderPaid),
        bargainprice: String(kanjia),
        items: [...itemInfo.values()],
        coupon_fee: String(couponFee),
      },
    };
  }

  /** 旧 itemInfo 聚合：同 key 累加数量；首次创建带基础字段（其余字段每次迭代由调用方覆盖） */
  private ensureItem(
    itemInfo: Map<string, ChromeValidatedItem>,
    uniqueKey: string,
    itemId: string,
    detail: PlatformProductItem,
    order: ChromeOrderRow,
  ): ChromeValidatedItem {
    const existing = itemInfo.get(uniqueKey);
    if (existing) {
      existing.quantity += order.goodsnum ?? 0;
      return existing;
    }
    const created: ChromeValidatedItem = {
      offerId: itemId,
      name: String(detail.name ?? ''),
      specId: detail.specId ?? null,
      quantity: order.goodsnum ?? 0,
      price: order.goodsprice,
      real_price: Number(detail.price ?? 0),
      real_pay: Number(detail.itemAmount ?? 0),
      sku_info: {},
      ids: [],
    };
    itemInfo.set(uniqueKey, created);
    return created;
  }

  /**
   * 旧「尝试修正砍后单价」+「商品实际单价大于后台单价」守卫（返回错误文案，null = 通过）。
   * 触发条件 1:1：1688 恒判；淘宝仅非 ACTION_SAVE（旧注释：淘宝采购插件回传单价不准确）。
   */
  private correctAndCheckPrice(
    entry: ChromeValidatedItem,
    detail: PlatformProductItem,
    order: ChromeOrderRow,
    type: number,
    action: number | null,
    skipPriceCheck: boolean,
  ): string | null {
    if (
      type !== CHROME_TRADE_TYPE.ALIBABA &&
      (type !== CHROME_TRADE_TYPE.TAOBAO || action === CHROME_ACTION.SAVE)
    ) {
      return null;
    }

    const price = moneyOf(Number(detail.price ?? 0));
    const quantity = Number(detail.quantity ?? 0);
    const itemAmount = moneyOf(Number(detail.itemAmount ?? 0));

    if (moneyOf(price * quantity) > itemAmount && quantity > 0) {
      // 旧 `round($itemAmount / $quantity, 2)`；quantity=0 时 PHP 会除零抛错——此处不修正（S49）
      entry.real_price = money(itemAmount / quantity);
    }

    if (!skipPriceCheck && moneyOf(order.goodsprice) < entry.real_price) {
      return `商品实际单价大于后台单价，请与用户沟通并修正单价后再进行采购。订单 ID：${order.oid}，后台单价：${order.goodsprice}，实际单价：${entry.real_price}。`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // 旧 validateAndSave
  // -------------------------------------------------------------------------

  async validateAndSave(ctx: ChromeContext): Promise<ChromeResult> {
    const validated = await this.validateByOidAndTradeId(ctx);
    if (validated.code !== 200) return validated;

    const orders = await this.repo.listOrdersForChrome(this.db, ctx.oids);
    // 旧 `$orders->where('state','!=',STATE_WAIT_CREATE)->first()`
    if (orders.some((o) => o.state !== 1)) {
      return { code: 40000, msg: '有订单处未处于待采购状态，暂不支持更新。' };
    }

    let orderDetail = { ...ctx.orderDetail };
    if (ctx.detailAction !== CHROME_ACTION.MODIFY_ORDER) {
      // 旧：用校验结果里的 post_fee / real_pay / coupon_fee 覆盖 order_detail
      orderDetail = {
        ...orderDetail,
        send_price: validated.data!.post_fee,
        real_pay: validated.data!.real_pay,
        coupon_fee: validated.data!.coupon_fee,
      };
    }

    return this.saveOrderInfo({ ...ctx, orderDetail }, validated);
  }

  // -------------------------------------------------------------------------
  // 旧 saveOrderInfo（+ BatchUpdateOrder 有效子集）
  // -------------------------------------------------------------------------

  async saveOrderInfo(ctx: ChromeContext, validated?: ChromeResult): Promise<ChromeResult> {
    const validateResult = validated ?? (await this.validateByOidAndTradeId(ctx));
    if (validateResult.code !== 200) return validateResult;

    const orders = await this.repo.listOrdersForChrome(this.db, ctx.oids);
    const amountSummary = summarizeAmountCalculationOrders(orders);

    const sendPrice = moneyOf(Number(ctx.orderDetail['send_price'] ?? 0));
    const realPay = moneyOf(Number(ctx.orderDetail['real_pay'] ?? 0));
    const couponFee = moneyOf(Number(ctx.orderDetail['coupon_fee'] ?? 0));
    const seller = ctx.orderDetail['seller'];

    const baseline = computePriceBaseline({
      goodsTotal: amountSummary.goodsTotal,
      dbSendPrice: amountSummary.sendpriceTotal,
      platformSendPrice: sendPrice,
      realPay,
    });
    if (baseline.blocked) {
      this.deps.riskLog?.({
        channel: 'webhook_1688',
        message: '1688 price modify blocked by risk control',
        tid: ctx.input.tradeId,
        ...baseline.riskLog,
      });
      return { code: 40000, msg: baseline.blockMessage };
    }

    const saved = await this.applyBatchUpdateOrder({
      oids: ctx.oids,
      tid: ctx.input.tradeId,
      bargainprice: baseline.bargainprice,
      sendprice: baseline.sendPrice,
      couponFee,
      seller: seller === undefined || seller === null ? '' : String(seller),
      admin: ctx.admin,
    });
    if (!saved.status) return { code: 40000, msg: saved.message ?? null };

    return { code: 200 };
  }

  /**
   * 旧 `(new BatchUpdateOrder())->handle($params, $options)`（radio [1,4,9,14] 的有效子集）。
   *
   * 完整表单支持 14 类更新（状态/物流/检品/变量…），chrome 面只提交 tid+砍价+运费+红包，
   * 因此这里只保留该子集的 **守卫链** 与写法：
   *   白名单 → 金额态守卫 → 终态守卫 → 店铺名校验 → 采购员分配 → 下单时间 →
   *   金额承载单迁移 → 运费/砍价/红包落库 → 砍价记录 → 统一 syncOrder
   */
  private async applyBatchUpdateOrder(input: {
    oids: number[];
    tid: string;
    bargainprice: number;
    sendprice: number;
    couponFee: number;
    seller: string;
    admin: ChromeAdminIdentity;
  }): Promise<{ status: boolean; message?: string }> {
    const oids = input.oids;
    // 旧 `explode(',', $input['ids'])`：空/非法值不参与（MySQL 的 whereIn 同样匹配不到）
    if (oids.length === 0) return { status: false };

    // ① 金额态守卫（旧 AMOUNT_UPDATE_FIELDS + isAmountCalculationExcludedState）
    const states = await this.repo.listOrderStates(this.db, oids);
    const invalid = states.filter((r) => r.state === 6 || r.state === 10 || r.state === 11);
    if (invalid.length > 0) {
      return {
        status: false,
        message: `订单状态无效，不支持修改金额相关字段。无效订单ID：${invalid.map((r) => r.oid).join('、')}`,
      };
    }

    const orders = await this.repo.listOrdersForChrome(this.db, oids);
    // ② 终态守卫（旧 finalStates = [已返金, 已废弃]）
    if (orders.some((o) => o.state !== null && FINAL_STATES.includes(o.state))) {
      return { status: false, message: '无效（已返金、已废弃）订单，不能编辑' };
    }

    // ③ 店铺名校验（旧 `$orders->where('goodsseller','!=',$seller)->first()`）
    if (input.seller !== '') {
      const mismatch = orders.find((o) => (o.goodsseller ?? '') !== input.seller);
      if (mismatch) {
        return {
          status: false,
          message: `获取卖家昵称失败，可能是因为您采购期间点击了其他订单，请校对后重试或到后台自助填写订单信息。后台昵称：${mismatch.goodsseller ?? ''}，当前昵称：${input.seller}。`,
        };
      }
    }

    // ④ 采购员分配（旧：`isset($input['tid']) && empty($input['payid'])` →
    //    路径不是 api/webhooks/1688 就分配当前后台账号的 payid。chrome 面恒分配）
    const ordersWithoutPayid = orders.filter((o) => !o.payid);
    if (ordersWithoutPayid.length > 0) {
      if (!input.admin.payid) {
        return {
          status: false,
          message: '当前账号未绑定采购员，暂不允许更新单号。请联系管理员处理。',
        };
      }
      await this.repo.updateOrdersForChrome(
        this.db,
        ordersWithoutPayid.map((o) => o.oid),
        { payid: input.admin.payid },
      );
    }

    // ⑤ 下单时间（旧：tid 从无到有的订单 → paytime=now + purchase_type=手动下单）
    const ordersWithoutTid = orders.filter((o) => !o.tid);
    if (ordersWithoutTid.length > 0) {
      await this.repo.updateOrdersForChrome(
        this.db,
        ordersWithoutTid.map((o) => o.oid),
        { paytime: this.nowSec(), purchase_type: PURCHASE_TYPE_MANUAL },
      );
    }

    // ⑥ 白名单字段（旧 updateData：只有 tid 会进这里，三个金额字段走载体逻辑）
    const updateData: { tid: string } = { tid: input.tid };

    let updateFlag = false;
    try {
      return await this.deps.runTx(async (tx) => {
        this.deferredSync.begin();
        try {
          // ⑦ 先写白名单字段（旧 `Order::updateOrder($keys,$updateData)` 在金额块**之前**）——
          // 顺序有语义：tid 落库后承载单解析才会按新 tid 归组（旧代码同样如此）
          this.deps.auditLog?.({ change: updateData, oids });
          await this.repo.updateOrdersForChrome(tx, oids, updateData);
          updateFlag = true;

          // ⑧ 金额承载单（旧 resolveManualAmountCarrierOrder ?? resolveAmountHolderOrder）
          // ⚠ 候选集用**更新前读出**的 orders（旧 `$orders` 集合是 tid 落库前取的，1:1）
          // dg_order.goodsprice1 是 Decimal(10,2)（bargainprice/sendprice 才是 Float）⇒ 进金额链前转 number
          const amountRows = orders.map((o) => ({
            ...o,
            goodsprice1: o.goodsprice1 === null ? null : Number(o.goodsprice1),
          }));
          let carrier = null as Awaited<ReturnType<typeof resolveAmountCarrier>>;
          if (amountRows.length === 1) {
            carrier = await migrateAmountCarrier(
              tx,
              amountRows[0]!,
              shanghaiWallClock(this.deps.now()),
            );
          }
          carrier ??= await resolveAmountCarrier(tx, amountRows);

          const amountUpdateData: { sendprice?: number; bargainprice?: number } = {};

          // ⑨ 运费
          // ⚠ 旧代码是 `throw new RuntimeException(...)`（→ 整体回滚）而不是返回错误
          if (!carrier) throw new Error('所选订单均为无效订单，不能参与运费计算。');
          if (!moneyEquals(input.sendprice, carrier.sendprice ?? 0)) {
            amountUpdateData.sendprice = input.sendprice;
          }

          // ⑩ 红包（旧 V2OrderDetail::updateOrCreate，恒写不比较）
          if (!carrier) throw new Error('所选订单均为无效订单，不能参与返金计算。');
          await this.repo.upsertOrderDetailCouponFee(
            tx,
            carrier.oid,
            input.couponFee,
            shanghaiWallClock(this.deps.now()),
          );

          // ⑪ 砍价
          if (!carrier) throw new Error('所选订单均为无效订单，不能参与砍价计算。');
          if (!moneyEquals(input.bargainprice, carrier.bargainprice ?? 0)) {
            amountUpdateData.bargainprice = input.bargainprice;
          }

          if (Object.keys(amountUpdateData).length > 0) {
            this.deps.auditLog?.({ change: amountUpdateData, oids: [carrier.oid] });
            await this.repo.updateOrderForChrome(tx, carrier.oid, amountUpdateData);
            await this.deferredSync.dispatch(tx, [carrier.oid], Object.keys(amountUpdateData));
            updateFlag = true;
          }

          // ⑫ 砍价记录（旧 BargainRecord::updateOrCreate 逐单写，跳过无效态）
          const refreshed = await this.repo.listOrdersForChrome(tx, oids);
          const nowSec = this.nowSec();
          for (const order of refreshed) {
            if (order.state === 6 || order.state === 10 || order.state === 11) continue;
            await this.repo.upsertBargainRecord(tx, {
              goodid: String(order.goodsid ?? ''),
              goodstype: order.goodssite === '1688' ? 1 : 0,
              oid: order.oid,
              goodsnum: order.goodsnum ?? 0,
              goodsamt: moneyOf(order.goodsprice * (order.goodsnum ?? 0)),
              orgprice: moneyOf(order.goodsprice),
              bgprice: moneyOf(Number(order.goodsprice1 ?? 0)),
              adminname: input.admin.username,
              adminid: input.admin.id,
              addtime: nowSec,
            });
          }

          if (!updateFlag) throw new Error('没有要更新的内容。');

          // ⑬ 旧 Order::syncOrder（SYNC_METHOD=database ⇒ 只回读，新系统自身即正本 → no-op）
          await this.deferredSync.flush(tx);
          return { status: true };
        } catch (e) {
          this.deferredSync.discard();
          throw e;
        }
      });
    } catch (e) {
      return { status: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** 供组合根/路由复用的 `$extra` 构造（旧 webhookForChrome 的 extra 组装 1:1） */
export function chromeContextOf(
  input: ChromeWebhookInput,
  admin: ChromeAdminIdentity,
): ChromeContext {
  return {
    input,
    oids: input.oids
      .split(',')
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0),
    orderDetail: input.orderDetail ?? {},
    detailAction:
      input.orderDetail?.action === undefined || input.orderDetail?.action === null
        ? null
        : Number(input.orderDetail.action),
    admin,
  };
}

/** 旧 `Arr::get($extra,'order_detail')` 的 JSON 解码（`is_string ? json_decode : 原样`） */
export function decodeOrderDetail(raw: unknown): ChromeOrderDetail | null {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as ChromeOrderDetail) : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && raw !== null ? (raw as ChromeOrderDetail) : null;
}
