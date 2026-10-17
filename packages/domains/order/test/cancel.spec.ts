import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import type { Principal } from '@crossbuy/auth';
import { OrderRepository } from '../src/repository';
import { OrderServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

/**
 * 取消订单链路单测（旧 OrderCancelServiceTest / CancelMemberOrderServiceTest 的 Vitest 翻译
 * + docs/plans/09 §1.1 状态迁移验收）。连真实 MySQL，事务回滚不污染 dump。
 *
 * 事务注入：service 的 runTx 复用外层 withRollback 事务——守卫/动账/金额同步与造数据
 * 同一事务，回滚零残留。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let oidSeq = 9_900_000;
function nextOid(): number {
  return ++oidSeq;
}

/** 会员行（uid 唯一避免锁等待；money 起点 100.00） */
function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  const uname = `ordertest_${Math.random().toString(36).slice(2, 8)}`;
  return {
    uname,
    password: '5f4dcc3b5aa765d61d8327deb882cf99',
    card: 'test',
    memberid: uname,
    email: null,
    money: 100,
    dfflag: 0,
    utype: 0,
    validity: 0,
    dffee: 10,
    state: 1,
    ...overrides,
  };
}

/** 订单行（旧 dg_order 取消链路列集的最小形态 + 无默认必填字符串列补空串） */
function makeOrder(uid: number, overrides: Record<string, unknown> = {}) {
  const oid = nextOid();
  return {
    oid,
    uid,
    uname: 'ordertest',
    memberid: `ordertest_${uid}`,
    tid: '',
    sid: null,
    type: 1, // DG
    state: 1, // WAIT_CREATE
    goodsprice: 100,
    goodsprice1: 0,
    goodsnum: 1,
    bargainprice: 0,
    sendprice: 0,
    inspection: 0,
    goodsurl: 'https://item.taobao.com/item.htm?id=1',
    goodsname: 'テスト商品',
    extend: null as string | null,
    addtime: Math.floor(Date.now() / 1000),
    uptime: Math.floor(Date.now() / 1000),
    // dg_order 无默认必填字符串列（introspect 实测，禁省略）
    yanhuofba: '', yanhuojinyun: '', yanhuozengzhi: '', yanhuoasin: '', yanhuofnsku: '',
    baozhuang: '', hbbaozhuang: '', baonum: '', SKU: '',
    shangpin_sku: '', FNSKU: '', shangpin_fnsku: '', name: '',
    shangpin_name: '', amazon: '', putong: '', shangpin_amazon: '',
    fuzhuang: '', tiebiao: '', huanbaoz: '', qita: '',
    ...overrides,
  };
}

function memberPrincipal(uid: number): Principal {
  return { kind: 'member', subject: String(uid), isDf: false } as Principal;
}

function makeService(tx: LegacyPrisma.TransactionClient): OrderServiceImpl {
  return new OrderServiceImpl(new OrderRepository(tx), () => new Date('2026-10-17T10:00:00+08:00'), (fn) => fn(tx));
}

async function seedUser(tx: LegacyPrisma.TransactionClient, overrides: Record<string, unknown> = {}) {
  const row = makeUser(overrides);
  const created = await tx.dg_users.create({ data: { ...row } as never });
  return created;
}

async function seedOrder(tx: LegacyPrisma.TransactionClient, overrides: Record<string, unknown> = {}) {
  const row = makeOrder(overrides.uid as number, overrides);
  const { oid, ...data } = row;
  // raw INSERT：本地 dump 落后生产 schema（缺 buyer_remark_icon 等列），Prisma create
  // 会引用不存在的列。只写取消链路相关列 + dump 无默认必填列（information_schema 核实）。
  const cols = ['oid', ...Object.keys(data)] as const;
  const vals = [oid, ...Object.values(data).map((v) => (v === null ? null : typeof v === 'number' ? v : String(v)))];
  const placeholders = cols.map(() => '?').join(',');
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_order (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${placeholders})`,
    ...vals,
  );
  return row;
}

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------

describe('cancelOrders 守卫（旧 OrderCancelService::ensureCancelable 顺序 1:1）', () => {
  it('空 oid 列表（归一化后）→ ORDER_NOT_FOUND', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_NOT_FOUND');
    });
  });

  it('不存在的 oid → ORDER_NOT_FOUND（数量不符分支，不改任何行）', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [987654321]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_NOT_FOUND');
    });
  });

  it('别人的订单 → NO_PERMISSIONS（uid 归属校验先于状态校验）', async () => {
    await withRollback(async (tx) => {
      const owner = await seedUser(tx);
      const other = await seedUser(tx);
      const order = await seedOrder(tx, { uid: owner.uid, state: 1 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(other.uid), [order.oid]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NO_PERMISSIONS');
    });
  });

  it('state=2（已采购）不可取消 → ORDER_NOT_ALLOWED_CANCEL', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const order = await seedOrder(tx, { uid: user.uid, state: 2 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_NOT_ALLOWED_CANCEL');
      // 事务回滚兜底断言：状态未变
      const after = await tx.dg_order.findUnique({ where: { oid: order.oid }, select: { state: true, bargainprice: true, sendprice: true, uptime: true } });
      expect(after?.state).toBe(2);
    });
  });

  it('非会员 Principal → NO_PERMISSIONS（不触库）', async () => {
    await withRollback(async (tx) => {
      const result = await makeService(tx).cancelOrders({ kind: 'admin', subject: '1' } as Principal, [1]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NO_PERMISSIONS');
    });
  });

  it('重复 oid 去重（旧 normalizeOrderIds unique）——[oid, oid] 只处理一次', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const order = await seedOrder(tx, { uid: user.uid });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid, order.oid]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([order.oid]);
      const records = await tx.dg_record.findMany({ where: { uid: user.uid, action: 4 } });
      expect(records).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 返金计算
// ---------------------------------------------------------------------------

describe('返金计算（旧 calculateRefundAmount 三分支 1:1）', () => {
  it('DG 非定额用户：返金 = goodsTotal + ceil(5% 服务费到分)，record.oid = oid、ordflag = DG(1)', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      // goodsTotal = (100 + 20) * 2 = 240 → 服务费 ceil(240*0.05*100)/100 = 12 → 252
      const order = await seedOrder(tx, { uid: user.uid, goodsprice: 100, inspection: 20, goodsnum: 2 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(true);

      const record = await tx.dg_record.findFirst({ where: { uid: user.uid, action: 4 } });
      expect(record?.money?.toString()).toBe('252');
      expect(record?.type).toBe(2); // TYPE_INCR
      expect(record?.oid).toBe(order.oid);
      expect(record?.ordflag).toBe(1); // ORDER_FLAGS.DG
      expect(record?.accountmoney?.toString()).toBe('352'); // 100 + 252 快照
      expect(record?.remark).toContain(`<a href=\\'${order.goodsurl}\\'`);
      expect(record?.remark).toContain('オーダーID:');
      expect(record?.remark).not.toContain('直送');

      const after = await tx.dg_users.findUnique({ where: { uid: user.uid }, select: { money: true } });
      expect(after?.money.toString()).toBe('352');
    });
  });

  it('DG 定额用户（validity 未来 + utype=1）：全额返金、无服务费', async () => {
    await withRollback(async (tx) => {
      const validity = Math.floor(new Date('2027-01-01T00:00:00+08:00').getTime() / 1000);
      const user = await seedUser(tx, { utype: 1, validity });
      const order = await seedOrder(tx, { uid: user.uid, goodsprice: 100, inspection: 20, goodsnum: 2 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(true);

      const record = await tx.dg_record.findFirst({ where: { uid: user.uid, action: 4 } });
      expect(record?.money?.toString()).toBe('240'); // (100+20)*2 全额
    });
  });

  it('DG 服务费抵减：extend.deducted_service_fee 超过服务费 → 抵减到 0 不为负', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      // goodsTotal=240 → 服务费 12；deducted=15 → actual = max(0, 12-15) = 0 → 返金 240
      const order = await seedOrder(tx, {
        uid: user.uid,
        goodsprice: 100,
        inspection: 20,
        goodsnum: 2,
        extend: JSON.stringify({ deducted_service_fee: 15 }),
      });
      await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      const record = await tx.dg_record.findFirst({ where: { uid: user.uid, action: 4 } });
      expect(record?.money?.toString()).toBe('240');
    });
  });

  it('DF 非定额用户（ISAMTLIMIT=0）：返金 = (goodsprice + inspection + dffee) × goodsnum，record.oid = 0、ordflag = DF(3)', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx, { dffee: 10 });
      // (100 + 0 + 10) * 1 = 110
      const order = await seedOrder(tx, { uid: user.uid, type: 3, goodsprice: 100, goodsnum: 1 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(true);

      const record = await tx.dg_record.findFirst({ where: { uid: user.uid, action: 4 } });
      expect(record?.money?.toString()).toBe('110');
      expect(record?.oid).toBe(0); // DF 特例：oid 落 0
      expect(record?.ordflag).toBe(3); // ORDER_FLAGS.DF
      expect(record?.remark).toContain('直送');
    });
  });

  it('DF 一件代发用户本人（dfflag=1）：ordflag 强制 3（旧 addMoney 矫正）', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx, { dfflag: 1 });
      const order = await seedOrder(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 1 });
      await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      const record = await tx.dg_record.findFirst({ where: { uid: user.uid, action: 4 } });
      // type=1(DG) 传 ordflag=DG(1)，但 addMoney 里 dfflag==1 强制 3
      expect(record?.ordflag).toBe(3);
    });
  });

  it('ZY 转运单：返金 0（不写 record）但状态仍进 10', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const order = await seedOrder(tx, { uid: user.uid, type: 2 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(true);

      const records = await tx.dg_record.findMany({ where: { uid: user.uid, action: 4 } });
      expect(records).toHaveLength(0);

      const after = await tx.dg_order.findUnique({ where: { oid: order.oid }, select: { state: true, bargainprice: true, sendprice: true, uptime: true } });
      expect(after?.state).toBe(10);
      expect(Number(after?.bargainprice)).toBe(0);
      expect(after?.uptime).toBeGreaterThan(0);
    });
  });

  it('未知订单类型（type=0）→ ORDER_INVALID_TYPE（整批回滚）', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const order = await seedOrder(tx, { uid: user.uid, type: 0 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_INVALID_TYPE');
    });
  });
});

// ---------------------------------------------------------------------------
// 状态收尾与组金额
// ---------------------------------------------------------------------------

describe('状态收尾 + 组内 sendprice 转移 + 金额同步', () => {
  it('state=6（未返金无效单）也可取消 → 10（docs/plans/09 §1.1：10 = [1,6]）', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const order = await seedOrder(tx, { uid: user.uid, state: 6, goodsprice: 50 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(true);
      const after = await tx.dg_order.findUnique({ where: { oid: order.oid }, select: { state: true, bargainprice: true, sendprice: true, uptime: true } });
      expect(after?.state).toBe(10);
    });
  });

  it('sendprice≠0 且 tid 组内有活跃接收单：组内清零、接收单拿总额', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const tid = 'ordertest-tid-1';
      const a = await seedOrder(tx, { uid: user.uid, tid, sendprice: 10 }); // 取消单
      const b = await seedOrder(tx, { uid: user.uid, tid, sendprice: 0 }); // 接收单
      await makeService(tx).cancelOrders(memberPrincipal(user.uid), [a.oid]);

      const afterA = await tx.dg_order.findUnique({ where: { oid: a.oid }, select: { state: true, bargainprice: true, sendprice: true } });
      const afterB = await tx.dg_order.findUnique({ where: { oid: b.oid }, select: { state: true, bargainprice: true, sendprice: true } });
      expect(Number(afterA?.sendprice)).toBe(0);
      expect(Number(afterB?.sendprice)).toBe(10);
    });
  });

  it('sendprice≠0 且组内无其它活跃单：不清零不转移（旧 receiver 无 → return）', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const a = await seedOrder(tx, { uid: user.uid, tid: 'solo-tid', sendprice: 10 });
      await makeService(tx).cancelOrders(memberPrincipal(user.uid), [a.oid]);
      const after = await tx.dg_order.findUnique({ where: { oid: a.oid }, select: { state: true, bargainprice: true, sendprice: true, uptime: true } });
      // 转移步：receiver 无 → return（不清零）；但 flush 的金额归一化里 carrier=null
      // → 全组 sendprice 归零（旧 syncByOids normalizeOrderSendprice 同行为）——两层叠加后 = 0
      expect(Number(after?.sendprice)).toBe(0);
    });
  });

  it('取消后金额同步（flush）：dg_sendorder.bargainprice = Σ组内活跃单 bargainprice', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const tid = 'ordertest-tid-2';
      // 组内两单同 sid；b 单原本 bargainprice=8 → 取消 a（bargainprice 归 0）后 Σ = 0
      const a = await seedOrder(tx, { uid: user.uid, tid, sid: '55001', bargainprice: 3 });
      const b = await seedOrder(tx, { uid: user.uid, tid, sid: '55001', bargainprice: 8 });
      // raw INSERT 同因（dump 缺 schema 新列）：只写取消链路读的列 + dump 必填列
      await tx.$executeRawUnsafe(
        'INSERT INTO dg_sendorder (sid, uid, uname, memberid, bargainprice, xiwgfei, xwdj, consignee) VALUES (?, ?, ?, ?, ?, 0, \'\', \'\')',
        55001, user.uid, user.uname, user.memberid, 11,
      );

      await makeService(tx).cancelOrders(memberPrincipal(user.uid), [a.oid]);

      const afterSend = await tx.dg_sendorder.findUnique({ where: { sid: 55001 }, select: { bargainprice: true } });
      // syncSendOrders 按 sid 汇总**活跃**单（b 仍活跃）→ 8
      expect(Number(afterSend?.bargainprice)).toBe(8);
      const afterB = await tx.dg_order.findUnique({ where: { oid: b.oid }, select: { state: true, bargainprice: true, sendprice: true } });
      expect(Number(afterB?.bargainprice)).toBe(8);
      const afterA = await tx.dg_order.findUnique({ where: { oid: a.oid }, select: { state: true, bargainprice: true, sendprice: true } });
      expect(Number(afterA?.bargainprice)).toBe(0);
    });
  });

  it('批量取消：部分合法部分非法 → 整体失败（事务语义），无任何残留写入', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const okOrder = await seedOrder(tx, { uid: user.uid, goodsprice: 100 });
      const badOrder = await seedOrder(tx, { uid: user.uid, state: 3 });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [okOrder.oid, badOrder.oid]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_NOT_ALLOWED_CANCEL');
      // 注：测试注入 runTx=fn(tx) 无嵌套 savepoint，okOrder 的返金中间态在**本外层事务**
      // 里可见——生产 runTx=$transaction 抛错整体回滚（旧 Laravel 嵌套事务 savepoint 同义），
      // 这里只验证「失败信号 + 不再继续处理」语义本身。
      const still = await tx.dg_order.findUnique({ where: { oid: badOrder.oid }, select: { state: true } });
      expect(still?.state).toBe(3); // 非法单未被触碰
    });
  });

  it('软删订单（deleted_at 非空）→ ORDER_NOT_FOUND（OrderWithoutTrashed 语义）', async () => {
    await withRollback(async (tx) => {
      const user = await seedUser(tx);
      const order = await seedOrder(tx, { uid: user.uid, deleted_at: new Date() });
      const result = await makeService(tx).cancelOrders(memberPrincipal(user.uid), [order.oid]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_NOT_FOUND');
    });
  });
});
