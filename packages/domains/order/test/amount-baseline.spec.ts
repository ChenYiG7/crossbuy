import { describe, expect, it } from 'vitest';
import {
  computePriceBaseline,
  extractAlibabaAmounts,
  extractTaobaoGlobalAmounts,
  filterOrdersForAmountCalculation,
  isAmountCalculationExcludedState,
  summarizeAmountCalculationOrders,
  type AmountOrderRow,
} from '../src/amount-baseline';

/**
 * 订单金额基线（旧 Order::filter/summarize + saveOrderInfo 守卫 1:1）。
 * 纯函数，无需 DB——金额口径必须能被直锁。
 */

const row = (over: Partial<AmountOrderRow>): AmountOrderRow => ({
  oid: 1,
  state: 1,
  goodsnum: 1,
  goodsprice: 0,
  sendprice: 0,
  ...over,
});

describe('金额计算过滤（旧 isAmountCalculationExcludedState / filterOrders*）', () => {
  it('无效态 6/10/11 被排除，其余（含 0 与 null）参与计算', () => {
    expect(isAmountCalculationExcludedState(6)).toBe(true);
    expect(isAmountCalculationExcludedState(10)).toBe(true);
    expect(isAmountCalculationExcludedState(11)).toBe(true);
    // ⚠ 旧 `in_array((int)$state, ...)`：(int)null = 0 ⇒ null 态**参与**计算（怪癖照抄）
    expect(isAmountCalculationExcludedState(null)).toBe(false);
    expect(isAmountCalculationExcludedState(1)).toBe(false);
    expect(isAmountCalculationExcludedState('6')).toBe(true);
  });

  it('过滤后保持原顺序，只剔除无效态', () => {
    const orders = [
      row({ oid: 1, state: 1 }),
      row({ oid: 2, state: 6 }),
      row({ oid: 3, state: 11 }),
      row({ oid: 4, state: null }),
    ];
    expect(filterOrdersForAmountCalculation(orders).map((o) => o.oid)).toEqual([1, 4]);
  });
});

describe('summarizeAmountCalculationOrders（旧 1:1）', () => {
  it('goodsTotal = Σ(num×price)、sendpriceTotal = Σsendprice、total = 两者和（均 round2）', () => {
    const summary = summarizeAmountCalculationOrders([
      row({ oid: 1, goodsnum: 3, goodsprice: 10.5, sendprice: 5.25 }),
      row({ oid: 2, goodsnum: 2, goodsprice: 4, sendprice: 1.1 }),
      row({ oid: 3, state: 6, goodsnum: 99, goodsprice: 99, sendprice: 99 }), // 无效态：不参与
    ]);
    expect(summary.orders.map((o) => o.oid)).toEqual([1, 2]);
    expect(summary.goodsTotal).toBe(39.5); // 31.5 + 8
    expect(summary.sendpriceTotal).toBe(6.35);
    expect(summary.total).toBe(45.85);
  });

  it('空集合 → 全 0；缺列按 0 计（旧 `(float)($x ?? 0)`）', () => {
    const empty = summarizeAmountCalculationOrders([]);
    expect(empty).toMatchObject({ goodsTotal: 0, sendpriceTotal: 0, total: 0 });
    const sparse = summarizeAmountCalculationOrders([
      row({ goodsnum: null, goodsprice: null, sendprice: null }),
    ]);
    expect(sparse.total).toBe(0);
  });

  it('浮点噪声不进结果（0.1×3 + 0.2 = 0.5 精确）', () => {
    const summary = summarizeAmountCalculationOrders([
      row({ goodsnum: 1, goodsprice: 0.1, sendprice: 0.1 }),
      row({ goodsnum: 1, goodsprice: 0.1, sendprice: 0.1 }),
      row({ goodsnum: 1, goodsprice: 0.1 }),
    ]);
    expect(summary.goodsTotal).toBe(0.3);
    expect(summary.sendpriceTotal).toBe(0.2);
    expect(summary.total).toBe(0.5);
  });
});

describe('砍价基线守卫（旧 saveOrderInfo:544-571）', () => {
  const base = { goodsTotal: 100, dbSendPrice: 8, platformSendPrice: 10, realPay: 105 };

  it('正常砍价：基线 = 商品合计 + **平台**运费，砍价 = 基线 − 实付', () => {
    const r = computePriceBaseline(base);
    expect(r.originalPrice).toBe(110); // 100 + 10（不是 DB 的 8）
    expect(r.bargainprice).toBe(5);
    expect(r.blocked).toBe(false);
    expect(r.blockMessage).toBeNull();
  });

  it('实付 > 基线 → 阻断（bargainprice < 0）且文案含三段金额', () => {
    const r = computePriceBaseline({ ...base, realPay: 120 });
    expect(r.bargainprice).toBe(-10);
    expect(r.blocked).toBe(true);
    expect(r.blockMessage).toContain('实际付款不能大于当前本地价格基线，已阻断自动改价。');
    expect(r.blockMessage).toContain('本地商品合计：100');
    expect(r.blockMessage).toContain('本地运费：8'); // DB 运费只出现在文案里
    expect(r.blockMessage).toContain('平台运费：10');
    expect(r.blockMessage).toContain('本地价格基线：110');
    expect(r.blockMessage).toContain('实际付款：120');
  });

  it('恰好相等 → 砍价 0，不阻断（守卫是严格 <0）', () => {
    const r = computePriceBaseline({ ...base, realPay: 110 });
    expect(r.bargainprice).toBe(0);
    expect(r.blocked).toBe(false);
  });

  it('riskLog 五字段与旧风控日志 context 同形', () => {
    const r = computePriceBaseline({ ...base, realPay: 120 });
    expect(r.riskLog).toEqual({
      localGoodsTotal: 100,
      localSendprice: 8,
      platformSendprice: 10,
      platformRealPay: 120,
      localBaselineTotal: 110,
    });
  });
});

describe('平台实付抽取（旧 validateOrderByOidAndTradeId 两族）', () => {
  it('1688：红包 couponFee 加回 totalAmount（旧口径，不加会虚高砍价）', () => {
    const withCoupon = extractAlibabaAmounts({ totalAmount: 90, shippingFee: 10, couponFee: 5 });
    expect(withCoupon.totalAmount).toBe(95);
    expect(withCoupon.couponAdded).toBe(true);
    const noCoupon = extractAlibabaAmounts({ totalAmount: 90, shippingFee: 10, couponFee: 0 });
    expect(noCoupon.totalAmount).toBe(90);
    expect(noCoupon.couponAdded).toBe(false);
    expect(extractAlibabaAmounts(null)).toMatchObject({
      totalAmount: 0,
      shippingFee: 0,
      couponFee: 0,
    });
  });

  it('淘宝：分转元；pay_amount 覆盖 purchase_amount；红包加回', () => {
    expect(
      extractTaobaoGlobalAmounts({ purchase_amount: 12500, domestic_post_fee: 800 }).totalAmount,
    ).toBe(125);
    expect(
      extractTaobaoGlobalAmounts({
        purchase_amount: 12500,
        pay_amount: 12000,
        domestic_post_fee: 800,
      }).totalAmount,
    ).toBe(120);
    const hongbao = extractTaobaoGlobalAmounts({
      pay_amount: 12000,
      hongbao_deduction_amount: 300,
      domestic_post_fee: 800,
    });
    expect(hongbao.couponFee).toBe(3);
    expect(hongbao.totalAmount).toBe(123); // 120 + 3
    expect(hongbao.couponAdded).toBe(true);
  });

  it('淘宝：domestic_post_fee 为空 → 回落 Σ 子单运费；shippingFee 分转元', () => {
    const r = extractTaobaoGlobalAmounts({
      purchase_amount: 10000,
      domestic_post_fee: 0,
      sub_purchase_orders: [{ domestic_post_fee: 500 }, { domestic_post_fee: 300 }, null],
    });
    expect(r.shippingFee).toBe(8);
    expect(r.totalAmount).toBe(100);
  });
});
