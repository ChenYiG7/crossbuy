import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import { ShipmentService, normalizeExpressNoString } from '../src/shipment';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

/** 订单行（发货回传链路最小形态；raw INSERT——dump 缺列 S21 同款） */
async function seedOrder(
  tx: Tx,
  input: { tid: string; state: number; expressno?: string; goodssite?: string; type?: number },
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_order (uid, uname, memberid, tid, goodssite, type, state, goodsprice, goodsprice1, goodsnum, bargainprice, sendprice, inspection, goodsurl, goodsname, extend, addtime, uptime, expressno, waytime, yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU, shangpin_sku, FNSKU, shangpin_fnsku, name, shangpin_name, amazon, putong, shangpin_amazon, fuzhuang, tiebiao, huanbaoz, qita)
     VALUES (1, 'shipuser', '', ?, ?, ?, ?, 100, 0, 1, 0, 0, 0, 'https://e.com/1', 'x', NULL, ?, ?, ?, NULL, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '')`,
    input.tid, input.goodssite ?? '1688', input.type ?? 1, input.state, now, now, input.expressno ?? '',
  );
  const row = await tx.$queryRawUnsafe<Array<{ oid: number }>>('SELECT oid FROM dg_order WHERE tid = ? AND state = ? ORDER BY oid DESC LIMIT 1', input.tid, input.state);
  return Number(row[0]!.oid);
}

function makeService(tx: Tx): ShipmentService {
  return new ShipmentService({
    repository: new OrderRepository(tx as never),
    runTx: (fn) => fn(tx as never),
    now: () => new Date('2026-10-17T21:00:00+08:00'),
  });
}

describe('发货回传（updateExpressNoForChrome / batchUpdateExpressno 1:1）', () => {
  it('chrome 面：已付款订单 → state=3 + waytime + 单号 + 入库登记（多单号逐个建）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const oid = await seedOrder(tx, { tid: 'T-ship-1', state: 2 });
      const svc = makeService(tx);

      const result = await svc.updateExpressNoForChrome({ tid: 'T-ship-1', expressNo: 'SF111 SF222' });
      expect(result).toEqual({ code: 200 });

      const order = await tx.dg_order.findUnique({ where: { oid }, select: { state: true, waytime: true, expressno: true } });
      expect(order?.state).toBe(3);
      expect(order?.waytime).toBe(Math.floor(new Date('2026-10-17T21:00:00+08:00').getTime() / 1000));
      expect(order?.expressno).toBe('SF111 SF222');
      // 两个单号各建一条入库记录 + pivot 关联
      const arrivals = await tx.v2_logistic_domestic.findMany({ where: { expressno: { in: ['SF111', 'SF222'] } }, select: { id: true, provider_code: true, state: true } });
      expect(arrivals).toHaveLength(2);
      const pivots = await tx.v2_relation_order_and_logistic_domestic.findMany({ where: { oid: BigInt(oid) } });
      expect(pivots).toHaveLength(2);
    });
  });

  it('chrome 面：tid 缺失/空单号 → 40000 参数错误；无已付款订单 → 40000 订单不存在', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const svc = makeService(tx);
      expect(await svc.updateExpressNoForChrome({ tid: '', expressNo: 'SF1' })).toEqual({ code: 40000, msg: '参数错误' });
      expect(await svc.updateExpressNoForChrome({ tid: 'T-none', expressNo: 'SF1' })).toEqual({ code: 40000, msg: '订单不存在' });
    });
  });

  it('批量面：已付款空单号 → 推进；已发货不一致 → 只改单号；幂等 → idempotent_tids', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      await seedOrder(tx, { tid: 'T-batch-1', state: 2 }); // 空单号已付款
      await seedOrder(tx, { tid: 'T-batch-2', state: 3, expressno: 'SF-OLD' });
      await seedOrder(tx, { tid: 'T-batch-3', state: 3, expressno: 'SF-SAME' });
      const svc = makeService(tx);

      // ① T-batch-1 推进；② T-batch-2 只改单号；③ T-batch-3 幂等
      const r = await svc.batchUpdateExpressno([
        { tid: 'T-batch-1', express_detail: { expressId: [{ expressNo: 'SF-NEW1', companyNo: 'YTO' }] } },
        { tid: 'T-batch-2', express_detail: { expressId: [{ expressNo: 'SF-NEW2' }] } },
        { tid: 'T-batch-3', express_detail: { expressId: [{ expressNo: 'SF-SAME' }] } },
      ], '1688');
      expect(r.code).toBe(200);
      expect(r.data!.idempotent_tids).toEqual(['T-batch-3']);
      expect(r.data!.failed_tids).toEqual([]);

      const o1 = await tx.dg_order.findFirst({ where: { tid: 'T-batch-1' }, select: { state: true, expressno: true } });
      expect(o1?.state).toBe(3);
      expect(o1?.expressno).toBe('SF-NEW1');
      const o2 = await tx.dg_order.findFirst({ where: { tid: 'T-batch-2' }, select: { state: true, expressno: true } });
      expect(o2?.state).toBe(3); // 未推进（已是 3）
      expect(o2?.expressno).toBe('SF-NEW2'); // 只改单号
      // 入库登记带 companyNo
      const arrival = await tx.v2_logistic_domestic.findFirst({ where: { expressno: 'SF-NEW1' }, select: { provider_code: true } });
      expect(arrival?.provider_code).toBe('YTO');
    });
  });

  it('批量面：平台过滤（goodssite 不匹配的订单不可见）+ 失败名单', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      await seedOrder(tx, { tid: 'T-batch-4', state: 2, goodssite: '淘宝' });
      const svc = makeService(tx);

      // 1688 平台查不到该 tid 的已付款订单 → failed
      const r = await svc.batchUpdateExpressno([
        { tid: 'T-batch-4', express_detail: { expressId: [{ expressNo: 'SF-X' }] } },
      ], '1688');
      expect(r.code).toBe(40000);
      expect(r.data!.failed_tids).toEqual(['T-batch-4']);

      // 淘宝平台则成功
      const r2 = await svc.batchUpdateExpressno([
        { tid: 'T-batch-4', express_detail: { expressId: [{ expressNo: 'SF-X' }] } },
      ], '淘宝');
      expect(r2.code).toBe(200);
    });
  });

  it('批量面：空单号/空 tid → failedTids；normalizeExpressNoString 归一化', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const svc = makeService(tx);
      const r = await svc.batchUpdateExpressno([
        { tid: '', express_detail: { expressId: [] } },
        { tid: 'T-empty-express', express_detail: { expressId: [] } },
      ], '1688');
      expect(r.code).toBe(40000);
      expect(r.data!.failed_tids).toEqual(['', 'T-empty-express']);

      // 归一化：trim + 去重 + 排序
      expect(normalizeExpressNoString('B A B ')).toBe('A B');
      expect(normalizeExpressNoString('SF-A SF-B')).toBe('SF-A SF-B');
    });
  });

  it('chrome 面事务失败 → 40000 带错误信息（回滚语义由 runTx 实现方保证）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      await seedOrder(tx, { tid: 'T-fail', state: 2 });
      // 注入必败 runTx（模拟 DB 故障）
      const svc = new ShipmentService({
        repository: new OrderRepository(tx as never),
        runTx: async () => {
          throw new Error('mock db down');
        },
        now: () => new Date(),
      });
      const result = await svc.updateExpressNoForChrome({ tid: 'T-fail', expressNo: 'SF-1' });
      expect(result.code).toBe(40000);
      expect(result.msg).toContain('更新物流单号失败');
      expect(result.msg).toContain('mock db down');
    });
  });
});
