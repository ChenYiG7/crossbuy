import type { PlatformSnapshotStage } from '@crossbuy/contract';
import { PLATFORM_SNAPSHOT_STAGE_RANK } from '@crossbuy/contract';
import { money } from '@crossbuy/utils';
import type { Db } from './repository';

/**
 * 平台订单金额快照（旧 PlatformOrderAmountSnapshotService 1:1，v2_platform_order_amount）。
 *
 * 职责：1688 详情（getOrderDetail 的 data）→ first/latest 双列快照。
 * - 金额：按 latest_snapshot_at **只前进**（旧数据不覆盖新数据；多进程/时钟偏差防御）。
 *   不按阶段判断金额——paid 之后的 sync（退款/改价核对）带来的新数据必须能进来。
 * - 阶段：latest_stage 按.created<sync<price_modified<paid **单调不退**
 *   （300 秒延迟的 created Job 在 paid 之后到达时，不能把 paid 改回 created）。
 * - paid_at：stage=paid 时回填。
 * - 表唯一键 (platform, tid)：并发首写撞键 → 捕获后走 updateLatest（旧
 *   UniqueConstraintViolationException 同义）。
 */

/** baseInfo 保留字段（旧 BASE_KEYS） */
const BASE_KEYS = [
  'id',
  'status',
  'createTime',
  'payTime',
  'totalAmount',
  'shippingFee',
  'sumProductPayment',
  'discount',
  'couponFee',
  'refund',
  'tradeType',
  'stepPayAll',
] as const;

/** productItems[] 保留字段（旧 ITEM_KEYS） */
const ITEM_KEYS = [
  'productID',
  'skuID',
  'name',
  'price',
  'quantity',
  'itemAmount',
  'entryDiscount',
  'status',
] as const;

/** 旧 PLATFORM_1688 */
export const PLATFORM_1688 = '1688';

/** extract 输出（金额一律 round2；原始摘要三段） */
export interface PlatformSnapshotExtract {
  goods_total: number;
  shipping_fee: number | null;
  total_amount: number | null;
  coupon_fee: number | null;
  seller_adjust: number;
  raw: {
    baseInfo: Record<string, unknown>;
    newStepOrderList: Array<Record<string, unknown>>;
    productItems: Array<Record<string, unknown>>;
  };
}

/** Prisma Json 输入值域（raw 已确保可序列化；具体断言在使用点） */

/** 旧 getOrderDetail 返回 data 的宽松形态 */
export type AlibabaOrderDetail = Record<string, unknown>;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function onlyKeys(obj: unknown, keys: readonly string[]): Record<string, unknown> {
  const src = (typeof obj === 'object' && obj !== null ? obj : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/** 旧 extract 1:1：goods_total = Σ(price×quantity)；seller_adjust = Σ newStepOrderList.adjustFee */
export function extractSnapshot(detail: AlibabaOrderDetail): PlatformSnapshotExtract {
  const base = (
    typeof detail.baseInfo === 'object' && detail.baseInfo !== null ? detail.baseInfo : {}
  ) as Record<string, unknown>;
  const items = (Array.isArray(detail.productItems) ? detail.productItems : []).map((it) =>
    onlyKeys(it, ITEM_KEYS),
  );

  let goodsTotal = 0;
  for (const it of items) {
    goodsTotal += Number(it.price ?? 0) * Number(it.quantity ?? 0);
  }
  let adjust = 0;
  const stepList = (Array.isArray(base.newStepOrderList) ? base.newStepOrderList : []).map((s) =>
    onlyKeys(s, ['stepNo', 'payFee', 'postFee', 'adjustFee', 'discountFee']),
  );
  for (const step of stepList) {
    adjust += Number(step.adjustFee ?? 0);
  }

  return {
    goods_total: round2(goodsTotal),
    shipping_fee: base.shippingFee !== undefined ? round2(Number(base.shippingFee)) : null,
    total_amount: base.totalAmount !== undefined ? round2(Number(base.totalAmount)) : null,
    coupon_fee: base.couponFee !== undefined ? round2(Number(base.couponFee)) : null,
    seller_adjust: round2(adjust),
    raw: {
      baseInfo: onlyKeys(base, BASE_KEYS),
      newStepOrderList: stepList,
      productItems: items,
    },
  };
}

/**
 * 旧 record1688 1:1：快照失败**不抛**（catch + 记日志语义；快照失败不应阻断支付推进），
 * 返回 false 让调用方记日志（apps/api 的 pino）。
 */
export async function record1688Snapshot(
  db: Db,
  tid: string,
  detail: AlibabaOrderDetail,
  stage: PlatformSnapshotStage,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await doRecord(db, tid, detail, stage, now);
    return true;
  } catch (e) {
    // 非「唯一键冲突」的数据库错误不吞（旧 record1688 只吞 Throwable 记日志——1:1 保留，
    // 但返回 false 让机器面留痕）
    void e;
    return false;
  }
}

async function doRecord(
  db: Db,
  tid: string,
  detail: AlibabaOrderDetail,
  stage: PlatformSnapshotStage,
  now: Date,
): Promise<void> {
  if (tid === '' || !(typeof detail.baseInfo === 'object' && detail.baseInfo !== null)) {
    return; // 旧 doRecord 首判：baseInfo 缺失直接忽略
  }
  const x = extractSnapshot(detail);

  const existing = await db.v2_platform_order_amount.findUnique({
    where: { tid_platform: { tid, platform: PLATFORM_1688 } },
    select: { id: true },
  });

  if (!existing) {
    try {
      await db.v2_platform_order_amount.create({
        data: {
          platform: PLATFORM_1688,
          tid,
          first_stage: stage,
          first_snapshot_at: now,
          first_goods_total: money(x.goods_total),
          first_shipping_fee: x.shipping_fee === null ? null : money(x.shipping_fee),
          first_total_amount: x.total_amount === null ? null : money(x.total_amount),
          first_raw: x.raw as never,
          latest_stage: stage,
          latest_snapshot_at: now,
          latest_goods_total: money(x.goods_total),
          latest_shipping_fee: x.shipping_fee === null ? null : money(x.shipping_fee),
          latest_total_amount: x.total_amount === null ? null : money(x.total_amount),
          latest_coupon_fee: x.coupon_fee === null ? null : money(x.coupon_fee),
          latest_seller_adjust: money(x.seller_adjust),
          latest_raw: x.raw as never,
          paid_at: stage === 'paid' ? now : null,
        },
      });
      return;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // 并发首写：另一进程已建行 → 只更新 latest（旧 UniqueConstraintViolationException 分支）
    }
  }

  await updateLatest(db, tid, stage, x, now);
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** 旧 updateLatest 1:1：金额按 latest_snapshot_at 只前进；阶段单调不退；paid_at 回填 */
async function updateLatest(
  db: Db,
  tid: string,
  stage: PlatformSnapshotStage,
  x: PlatformSnapshotExtract,
  now: Date,
): Promise<void> {
  const row = await db.v2_platform_order_amount.findUnique({
    where: { tid_platform: { tid, platform: PLATFORM_1688 } },
    select: { latest_snapshot_at: true, latest_stage: true },
  });
  if (!row) return; // 旧「唯一键冲突后却找不到行」= 异常态，记日志（此处返回由调用方统一）

  // 金额：latest_snapshot_at <= now 才更新（只前进）
  const amountStale = row.latest_snapshot_at !== null && row.latest_snapshot_at > now;
  if (!amountStale) {
    await db.v2_platform_order_amount.update({
      where: { tid_platform: { tid, platform: PLATFORM_1688 } },
      data: {
        latest_snapshot_at: now,
        latest_goods_total: money(x.goods_total),
        latest_shipping_fee: x.shipping_fee === null ? null : money(x.shipping_fee),
        latest_total_amount: x.total_amount === null ? null : money(x.total_amount),
        latest_coupon_fee: x.coupon_fee === null ? null : money(x.coupon_fee),
        latest_seller_adjust: money(x.seller_adjust),
        latest_raw: x.raw as never,
      },
    });
  }

  // 阶段：rank 单调不退
  const currentRank =
    row.latest_stage && row.latest_stage in PLATFORM_SNAPSHOT_STAGE_RANK
      ? PLATFORM_SNAPSHOT_STAGE_RANK[row.latest_stage as PlatformSnapshotStage]
      : 0;
  if (currentRank <= PLATFORM_SNAPSHOT_STAGE_RANK[stage]) {
    await db.v2_platform_order_amount.update({
      where: { tid_platform: { tid, platform: PLATFORM_1688 } },
      data: { latest_stage: stage },
    });
  }

  if (stage === 'paid') {
    await db.v2_platform_order_amount.update({
      where: { tid_platform: { tid, platform: PLATFORM_1688 } },
      data: { paid_at: now },
    });
  }
}
