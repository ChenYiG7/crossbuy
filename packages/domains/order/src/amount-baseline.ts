import { moneyOf } from './money';
import { INVALID_STATES } from './legacy-constants';

/**
 * 订单金额基线（旧 `Order::filterOrdersForAmountCalculation` + `summarizeAmountCalculationOrders`
 * + `OrderController::saveOrderInfo` 的砍价基线守卫 1:1）。
 *
 * 用途：chrome 回传 `validateAndSave` / 淘宝全球购三族 / 1688 同步共用的**金额地基**——
 * 平台实付回写前必须先过「本地价格基线」守卫，否则平台侧砍价会把订单改成负数差额。
 *
 * ★ 这是旧系统**少数几个真正的资金守卫**之一（不像 #11a 那些裸奔点），必须 1:1 保真：
 *   `bargainprice < 0` ⇒ 直接阻断自动改价并返回可读的拦截信息（旧代码还打了
 *   `webhook_1688` channel 风控日志，此处把日志字段结构化返回，由组合根决定落哪）。
 *
 * ⚠ 旧计算链是 **float** 累加后 round；本实现按 `money.ts` 的既定口径走 Decimal
 *   （有意改善，双跑 diff 判读规则见该文件注释）。
 */

/** 参与金额计算的行（旧 Collection<Order> 的窄投影） */
export interface AmountOrderRow {
  oid: number;
  state?: number | null;
  goodsnum?: number | string | null;
  goodsprice?: number | string | null;
  sendprice?: number | string | null;
  tid?: string | null;
}

/** 旧 `summarizeAmountCalculationOrders` 的返回 */
export interface AmountSummary<T extends AmountOrderRow = AmountOrderRow> {
  orders: T[];
  /** Σ(goodsnum × goodsprice)，round2 */
  goodsTotal: number;
  /** Σsendprice，round2 */
  sendpriceTotal: number;
  /** goodsTotal + sendpriceTotal，round2 */
  total: number;
}

/**
 * 旧 `isAmountCalculationExcludedState`：`in_array((int)$state, $invalidStates, true)`。
 * ⚠ `(int)null === 0` 不在无效态内 ⇒ **state 为 null 的订单参与计算**（怪癖，照抄）。
 */
export function isAmountCalculationExcludedState(
  state: number | string | null | undefined,
): boolean {
  return INVALID_STATES.includes(Math.trunc(Number(state ?? 0)) as (typeof INVALID_STATES)[number]);
}

/** 旧 `filterOrdersForAmountCalculation` */
export function filterOrdersForAmountCalculation<T extends AmountOrderRow>(orders: T[]): T[] {
  return orders.filter((order) => !isAmountCalculationExcludedState(order.state));
}

/** 旧 `summarizeAmountCalculationOrders`（1:1，含「先过滤再累加」的顺序） */
export function summarizeAmountCalculationOrders<T extends AmountOrderRow>(
  orders: T[],
): AmountSummary<T> {
  const amountOrders = filterOrdersForAmountCalculation(orders);

  const goodsTotal = moneyOf(
    amountOrders.reduce(
      (acc, order) => acc + Number(order.goodsnum ?? 0) * Number(order.goodsprice ?? 0),
      0,
    ),
  );
  const sendpriceTotal = moneyOf(
    amountOrders.reduce((acc, order) => acc + Number(order.sendprice ?? 0), 0),
  );

  return {
    orders: amountOrders,
    goodsTotal,
    sendpriceTotal,
    total: moneyOf(goodsTotal + sendpriceTotal),
  };
}

/** 旧 `saveOrderInfo` 的砍价基线入参 */
export interface PriceBaselineInput {
  /** 本地商品合计（Σ goodsnum × goodsprice，已过滤无效态） */
  goodsTotal: number | string;
  /** 本地运费合计（**DB 里的** Σsendprice；只用于拦截信息，不参与砍价计算） */
  dbSendPrice: number | string;
  /** 平台运费（post_fee / domestic_post_fee） */
  platformSendPrice: number | string;
  /** 平台实付（real_pay / pay_amount） */
  realPay: number | string;
}

export interface PriceBaseline {
  /** 本地价格基线 = goodsTotal + platformSendPrice（⚠ 用的是**平台**运费，不是 DB 运费） */
  originalPrice: number;
  /** 砍价额 = 基线 − 实付 */
  bargainprice: number;
  /** 平台运费（round2，回写订单用） */
  sendPrice: number;
  /** 实付（round2，回写与拦截信息用） */
  realPay: number;
  /** true = 实付大于本地基线 → **阻断**自动改价（旧「实际付款不能大于…」分支） */
  blocked: boolean;
  /** 拦截文案（旧 msg，1:1 拼装）；未阻断时为 null */
  blockMessage: string | null;
  /** 风控日志字段（旧 Log::channel('webhook_1688')->warning 的 context） */
  riskLog: {
    localGoodsTotal: number;
    localSendprice: number;
    platformSendprice: number;
    platformRealPay: number;
    localBaselineTotal: number;
  };
}

/**
 * 旧 `saveOrderInfo` 的砍价基线计算 + 守卫（:544-571 1:1）。
 *
 * ⚠ 旧代码的 `bargainprice` 用**平台运费**而非 DB 运费参与基线（DB 运费只出现在
 *   拦截文案与风控日志里）——这是「平台说运费多少就按多少砍」的口径，照抄。
 */
export function computePriceBaseline(input: PriceBaselineInput): PriceBaseline {
  const sendPrice = moneyOf(input.platformSendPrice);
  const realPay = moneyOf(input.realPay);
  const goodsTotal = moneyOf(input.goodsTotal);
  const dbSendPrice = moneyOf(input.dbSendPrice);

  const originalPrice = moneyOf(goodsTotal + sendPrice);
  const bargainprice = moneyOf(originalPrice - realPay);
  const blocked = bargainprice < 0;

  return {
    originalPrice,
    bargainprice,
    sendPrice,
    realPay,
    blocked,
    blockMessage: blocked
      ? '实际付款不能大于当前本地价格基线，已阻断自动改价。' +
        ` 本地商品合计：${goodsTotal}` +
        ` 本地运费：${dbSendPrice}` +
        ` 平台运费：${sendPrice}` +
        ` 本地价格基线：${originalPrice}` +
        ` 实际付款：${realPay}`
      : null,
    riskLog: {
      localGoodsTotal: goodsTotal,
      localSendprice: dbSendPrice,
      platformSendprice: sendPrice,
      platformRealPay: realPay,
      localBaselineTotal: originalPrice,
    },
  };
}

// ---------------------------------------------------------------------------
// 平台实付抽取（旧 validateOrderByOidAndTradeId 的两族分支，纯函数）
// ---------------------------------------------------------------------------

/**
 * 旧 1688 分支（`baseInfo`）：红包（couponFee）**加回** totalAmount 再当砍价基线。
 *
 * ⚠ 这是「平台红包抵扣也算砍价」的口径——不加回去会让 bargainprice 虚高（订单看起来
 *   砍得更多），与旧系统对不上。照抄，不修。
 */
export interface AlibabaAmounts {
  shippingFee: number;
  totalAmount: number;
  couponFee: number;
  /** 红包抵扣被加回 totalAmount 时为 true（触发旧 logMessage） */
  couponAdded: boolean;
}

/** 旧 `(float)$v`：非数字/缺列一律 0（PHP 弱转换语义，禁让 NaN 进金额链） */
function floatOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function extractAlibabaAmounts(
  baseInfo: Record<string, unknown> | null | undefined,
): AlibabaAmounts {
  const couponFee = moneyOf(floatOf(baseInfo?.['couponFee']));
  const rawTotal = moneyOf(floatOf(baseInfo?.['totalAmount']));
  const couponAdded = couponFee !== 0;
  return {
    shippingFee: moneyOf(floatOf(baseInfo?.['shippingFee'])),
    totalAmount: couponAdded ? moneyOf(rawTotal + couponFee) : rawTotal,
    couponFee,
    couponAdded,
  };
}

/** 淘宝分支的订单详情（只取金额相关字段；旧 `$orderDetail`） */
export interface TaobaoGlobalDetail {
  /** 分为单位；为空时回落 Σ sub_purchase_orders[].domestic_post_fee */
  domestic_post_fee?: number | string | null;
  /** 分为单位 */
  purchase_amount?: number | string | null;
  /** 分为单位；非空即覆盖 purchase_amount */
  pay_amount?: number | string | null;
  /** 分为单位；红包抵扣，非空则加回 totalAmount */
  hongbao_deduction_amount?: number | string | null;
  sub_purchase_orders?: Array<{ domestic_post_fee?: number | string | null } | null> | null;
}

/**
 * 旧淘宝/淘宝全球购分支：分 → 元（`/100`）+ 红包加回。
 *
 * ⚠ 分转元用 **moneyOf(x/100)**（先除后舍入）——旧代码同样先除后 round，顺序一致。
 */
export function extractTaobaoGlobalAmounts(detail: TaobaoGlobalDetail): {
  shippingFee: number;
  totalAmount: number;
  couponFee: number;
  couponAdded: boolean;
} {
  const rawPostFee = Number(detail.domestic_post_fee ?? 0);
  const postFee =
    rawPostFee === 0
      ? (detail.sub_purchase_orders ?? []).reduce(
          (acc, item) => acc + Number(item?.domestic_post_fee ?? 0),
          0,
        )
      : rawPostFee;

  const shippingFee = moneyOf(postFee / 100);
  const payAmount = Number(detail.pay_amount ?? 0);
  let totalAmount = moneyOf(
    (payAmount !== 0 ? payAmount : Number(detail.purchase_amount ?? 0)) / 100,
  );

  const couponFee = moneyOf(Number(detail.hongbao_deduction_amount ?? 0) / 100);
  const couponAdded = couponFee !== 0;
  if (couponAdded) totalAmount = moneyOf(totalAmount + couponFee);

  return { shippingFee, totalAmount, couponFee, couponAdded };
}
