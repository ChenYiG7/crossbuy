import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import { parsePayTime, Webhook1688Service, type Webhook1688Deps } from '../src/webhook-1688';
import { extractSnapshot, record1688Snapshot } from '../src/platform-snapshot';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

/** 1688 支付订单夹具（tid + state=1 + goodssite=1688 + type=1） */
async function seedOrder1688(
  tx: Tx,
  overrides: Record<string, unknown> = {},
): Promise<{ oid: number; tid: string }> {
  const oid = 99_100_000 + Math.floor(Math.random() * 100_000);
  const tid = (overrides.tid as string) ?? `T${Math.floor(Math.random() * 1e12)}`;
  const now = Math.floor(Date.now() / 1000);
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_order
      (oid, uid, uname, memberid, tid, sid, type, state, goodsprice, goodsprice1, goodsnum, bargainprice,
       sendprice, inspection, goodsurl, goodsname, extend, addtime, uptime, sku_name, goodssite,
       conttime, yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU, FNSKU, shangpin_sku, shangpin_fnsku)
     VALUES (?, 1, 'wk1688', 'wk1688', ?, NULL, ?, ?, 100, 0, 1, 0,
             0, 0, 'https://e.com/x', 'x', ?, ?, ?, '', ?,
             ?, '', '', '', '', '', '', '', '', '', '', '', '')`,
    oid, tid, overrides.type ?? 1, overrides.state ?? 1, overrides.extend ?? null,
    overrides.addtime ?? now, overrides.uptime ?? now, overrides.goodssite ?? '1688',
    overrides.conttime ?? 0,
  );
  return { oid, tid };
}

function makeService(overrides: Partial<Webhook1688Deps> = {}): Webhook1688Service {
  return new Webhook1688Service({
    db: legacyPrisma,
    alibaba: { getOrderDetail: async () => null },
    recordSnapshot: async () => true,
    update1688PaidOrders: (db, tid, payTimeSec, nowSec) =>
      new OrderRepository(legacyPrisma).update1688PaidOrders(db, tid, payTimeSec, nowSec),
    runTx: (fn) => fn(legacyPrisma),
    now: () => new Date('2026-10-17T12:00:00+08:00'),
    ...overrides,
  });
}

describe('1688 支付 webhook（webhookFor1688 支付面复现）', () => {
  it('parsePayTime：空/13 位毫秒/YmdHisvO/自由文本 四形态', () => {
    const now = new Date('2026-10-17T12:00:00+08:00');
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(parsePayTime(null, now)).toBe(nowSec);
    expect(parsePayTime('', now)).toBe(nowSec);
    expect(parsePayTime(1_700_000_000_000)).toBe(1_700_000_000);
    expect(parsePayTime('20250117123456789+0900')).toBe(
      Math.floor(Date.UTC(2025, 0, 17, 12, 34, 56, 789) / 1000) - 9 * 3600,
    );
    // PHP strtotime 按会话时区解释（生产 +08:00）——实现用 Date.parse（本地时区），测试机同 +08
    expect(parsePayTime('2025-01-17 12:34:56')).toBe(Math.floor(new Date(2025, 0, 17, 12, 34, 56).getTime() / 1000));
    expect(parsePayTime('garbage', now)).toBe(nowSec);
  });

  it('update1688PaidOrders 条件 UPDATE：state 1→2 + conttime 首次回填不覆盖 + extend.payTime', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder1688(tx, { state: 1, conttime: 0 });
      const nowSec = Math.floor(new Date('2026-10-17T12:00:00+08:00').getTime() / 1000);
      const repo = new OrderRepository(legacyPrisma);

      const affected = await repo.update1688PaidOrders(tx, a.tid, 1_760_000_000, nowSec);
      expect(affected).toBe(1);
      const row = await tx.$queryRawUnsafe<Array<{ state: number; conttime: number; extend: string | null; uptime: number }>>(
        'SELECT state, conttime, extend, uptime FROM dg_order WHERE oid = ?',
        a.oid,
      );
      expect(Number(row[0]!.state)).toBe(2);
      expect(Number(row[0]!.conttime)).toBe(nowSec); // 首次回填
      expect(JSON.parse(row[0]!.extend ?? '{}')).toEqual({ payTime: 1_760_000_000 });
      expect(Number(row[0]!.uptime)).toBe(nowSec);
    });
  });

  it('幂等性：重投递不覆盖 conttime / payTime（state 已 2 仍匹配 [1,2] 但 conttime 守卫兜底）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder1688(tx, { state: 2, conttime: 1_700_000_000 });
      const repo = new OrderRepository(legacyPrisma);

      // state=2 仍在白名单内（旧 whereIn [1,2]），重投递 = state 再写 2 无害；conttime 不覆盖
      await repo.update1688PaidOrders(tx, a.tid, 1_760_000_000, 1_760_999_999);
      const row = await tx.$queryRawUnsafe<Array<{ conttime: number; state: number }>>(
        'SELECT conttime, state FROM dg_order WHERE oid = ?',
        a.oid,
      );
      expect(Number(row[0]!.conttime)).toBe(1_700_000_000);
      expect(Number(row[0]!.state)).toBe(2);
    });
  });

  it('守卫：goodssite 非 1688 / type 非代购 / state=5 不推进', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const wrongSite = await seedOrder1688(tx, { goodssite: '淘宝' });
      const wrongType = await seedOrder1688(tx, { type: 2 });
      const wrongState = await seedOrder1688(tx, { state: 5 });
      const repo = new OrderRepository(legacyPrisma);

      expect(await repo.update1688PaidOrders(tx, wrongSite.tid, 1, 2)).toBe(0);
      expect(await repo.update1688PaidOrders(tx, wrongType.tid, 1, 2)).toBe(0);
      expect(await repo.update1688PaidOrders(tx, wrongState.tid, 1, 2)).toBe(0);
    });
  });

  it('事件分发：PAY 事件 → 条件推进；currentStatus 不符静默 success；未知事件 success', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const order = await seedOrder1688(tx, { state: 1 });

      const svc = makeService({
        alibaba: {
          getOrderDetail: async (tid) => ({
            baseInfo: { payTime: 1_760_000_000, totalAmount: 123.45, shippingFee: 10 },
            productItems: [{ productID: 'p1', name: 'n', price: 50, quantity: 2 }],
          }),
        },
        update1688PaidOrders: (db, tid, payTimeSec, nowSec) =>
          new OrderRepository(legacyPrisma).update1688PaidOrders(tx, tid, payTimeSec, nowSec),
        recordSnapshot: async (db, tid, detail, stage) => {
          await record1688Snapshot(tx, tid, detail, stage, new Date('2026-10-17T12:00:00+08:00'));
          return true;
        },
      });

      const outcome = await svc.handle({ type: 'ORDER_BUYER_VIEW_ORDER_PAY', data: { orderId: order.tid, currentStatus: 'waitsellersend' } });
      expect(outcome.retryable).toBe(false);
      expect(outcome.ack.success).toBe(true);
      expect(outcome.ack.event_type).toBe('ORDER_BUYER_VIEW_ORDER_PAY');

      const row = await tx.$queryRawUnsafe<Array<{ state: number }>>('SELECT state FROM dg_order WHERE oid = ?', order.oid);
      expect(Number(row[0]!.state)).toBe(2);

      // currentStatus 不符 → 静默 success（1:1 旧 break）
      const skipped = await svc.handle({ type: 'ORDER_BUYER_VIEW_ORDER_PAY', data: { orderId: 'Tx', currentStatus: 'other' } });
      expect(skipped.ack.success).toBe(true);

      // 未知事件 → 静默 success（旧 switch 无 default）
      const unknown = await svc.handle({ type: 'SOMETHING_NEW' });
      expect(unknown.ack.success).toBe(true);

      // 建单事件 → S24：success + job pipeline pending
      const buyerMake = await svc.handle({ type: 'ORDER_BUYER_VIEW_BUYER_MAKE', data: { orderId: 'T1' } });
      expect(buyerMake.ack.reason).toBe('job pipeline pending');
    });
  });

  it('SDK 失败 → 503 retryable 信封；BATCH 整批事务回滚语义（失败信封）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const svc = makeService(); // 默认 alibaba stub 返回 null
      const pay = await svc.handle({ type: 'ORDER_BUYER_VIEW_ORDER_PAY', data: { orderId: 'T-nope', currentStatus: 'waitsellersend' } });
      expect(pay.retryable).toBe(true);
      expect(pay.ack.success).toBe(false);
      expect(pay.ack.reason).toContain('getOrderDetail failed');

      const batch = await svc.handle({ type: 'ORDER_BATCH_PAY', data: { batchPay: [{ orderId: 'T-x' }] } });
      expect(batch.retryable).toBe(true);

      // tid 空的批量项 → 200 + retryable:false（重试无用）
      const badBatch = await svc.handle({ type: 'ORDER_BATCH_PAY', data: { batchPay: [{ orderId: '' }] } });
      expect(badBatch.retryable).toBe(false);
      void tx;
    });
  });

  it('快照：首写 first/latest 双列 + 并发撞键走 updateLatest + 金额只前进 + 阶段单调', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const tid = `T${Math.floor(Math.random() * 1e12)}`;
      // 本地 dump 缺此表（只覆盖 160/174）→ 建同构表（DDL 按 Prisma schema 1:1）
      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS v2_platform_order_amount (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        platform VARCHAR(16) NOT NULL DEFAULT '1688',
        tid VARCHAR(64) NOT NULL,
        first_stage VARCHAR(16) NOT NULL,
        first_snapshot_at TIMESTAMP NULL,
        first_goods_total DECIMAL(12,2) NULL,
        first_shipping_fee DECIMAL(12,2) NULL,
        first_total_amount DECIMAL(12,2) NULL,
        first_raw JSON NULL,
        latest_stage VARCHAR(16) NULL,
        latest_snapshot_at TIMESTAMP NULL,
        latest_goods_total DECIMAL(12,2) NULL,
        latest_shipping_fee DECIMAL(12,2) NULL,
        latest_total_amount DECIMAL(12,2) NULL,
        latest_coupon_fee DECIMAL(12,2) NULL,
        latest_seller_adjust DECIMAL(12,2) NULL,
        latest_raw JSON NULL,
        paid_at TIMESTAMP NULL,
        created_at TIMESTAMP NULL,
        updated_at TIMESTAMP NULL,
        UNIQUE KEY uniq_tid_platform (tid, platform)
      )`);
      const t1 = new Date('2026-10-17T10:00:00+08:00');
      const t2 = new Date('2026-10-17T11:00:00+08:00');

      await record1688Snapshot(tx, tid, {
        baseInfo: { totalAmount: 100, shippingFee: 10 },
        productItems: [{ price: 50, quantity: 2 }],
      }, 'created', t1);
      const first = await tx.$queryRawUnsafe<Array<{ first_stage: string; latest_stage: string; latest_goods_total: string; paid_at: Date | null }>>(
        'SELECT first_stage, latest_stage, latest_goods_total, paid_at FROM v2_platform_order_amount WHERE tid = ?',
        tid,
      );
      expect(first[0]!.first_stage).toBe('created');
      expect(first[0]!.latest_stage).toBe('created');
      expect(Number(first[0]!.latest_goods_total)).toBe(100);

      // paid 后到（stage 单调）；金额更新（时间只前进）
      await record1688Snapshot(tx, tid, {
        baseInfo: { totalAmount: 120, shippingFee: 10, couponFee: 5 },
        productItems: [{ price: 60, quantity: 2 }],
      }, 'paid', t2);
      const after = await tx.$queryRawUnsafe<Array<{ latest_stage: string; latest_goods_total: string; paid_at: Date | null }>>(
        'SELECT latest_stage, latest_goods_total, paid_at FROM v2_platform_order_amount WHERE tid = ?',
        tid,
      );
      expect(after[0]!.latest_stage).toBe('paid');
      expect(Number(after[0]!.latest_goods_total)).toBe(120);
      expect(after[0]!.paid_at).not.toBeNull();

      // created 阶段迟到（旧 300s 延迟 Job 场景）：阶段不退 paid；金额时间戳更旧 → 不覆盖
      await record1688Snapshot(tx, tid, {
        baseInfo: { totalAmount: 999 },
        productItems: [],
      }, 'created', new Date('2026-10-17T09:00:00+08:00'));
      const stale = await tx.$queryRawUnsafe<Array<{ latest_stage: string; latest_goods_total: string }>>(
        'SELECT latest_stage, latest_goods_total FROM v2_platform_order_amount WHERE tid = ?',
        tid,
      );
      expect(stale[0]!.latest_stage).toBe('paid');
      expect(Number(stale[0]!.latest_goods_total)).toBe(120);
    });
  });

  it('extractSnapshot：goods_total=Σ price×quantity、seller_adjust=Σ adjustFee、raw 白名单', () => {
    const x = extractSnapshot({
      baseInfo: { totalAmount: 133, shippingFee: 10.005, couponFee: 2, newStepOrderList: [{ stepNo: 1, adjustFee: 3, payFee: 9 }] },
      productItems: [{ price: 50, quantity: 2, productID: 'p1', junk: 'drop' }],
    });
    expect(x.goods_total).toBe(100);
    expect(x.shipping_fee).toBe(10.01); // round2
    expect(x.total_amount).toBe(133);
    expect(x.coupon_fee).toBe(2);
    expect(x.seller_adjust).toBe(3);
    expect(Object.keys(x.raw.baseInfo)).not.toContain('junk');
    expect(x.raw.productItems[0]).toEqual({ productID: 'p1', name: undefined, price: 50, quantity: 2, itemAmount: undefined, entryDiscount: undefined, status: undefined });
  });
});
