import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import { OrderServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

let oidSeq = 98_500_000;
function nextOid(): number {
  oidSeq += 1;
  return oidSeq;
}

/** 会员 Principal（member 域同款形态） */
function memberPrincipal(uid: number) {
  return { kind: 'member', subject: String(uid) } as const;
}

function makeService(tx: Tx, displayFromSec = 0): OrderServiceImpl {
  return new OrderServiceImpl(
    new OrderRepository(tx as unknown as ConstructorParameters<typeof OrderRepository>[0]),
    () => new Date('2026-10-17T12:00:00+08:00'),
    (fn) => fn(tx),
    displayFromSec,
  );
}

/** raw INSERT dg_users（dump 落后 schema，Prisma create 会引用缺列 → S21 同款处理） */
async function seedUser(
  tx: Tx,
  overrides: Record<string, unknown> = {},
): Promise<{ uid: number; uname: string; memberid: string }> {
  const uname = `olist_${Math.random().toString(36).slice(2, 10)}`;
  const cols = [
    'uname',
    'password',
    'card',
    'memberid',
    'email',
    'money',
    'dfflag',
    'utype',
    'validity',
    'dffee',
    'state',
  ];
  const vals = [
    uname,
    'x',
    'test',
    uname,
    null,
    100,
    overrides.dfflag ?? 0,
    overrides.utype ?? 0,
    0,
    10,
    1,
  ];
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_users (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ...vals,
  );
  const u = await tx.dg_users.findFirst({ where: { uname }, select: { uid: true } });
  return { uid: Number(u!.uid), uname, memberid: uname };
}

/** raw INSERT dg_order（列集 = 列表 select 子集 + dump 必填列） */
async function seedOrder(
  tx: Tx,
  user: { uid: number; uname: string; memberid: string },
  overrides: Record<string, unknown> = {},
): Promise<{ oid: number }> {
  const oid = (overrides.oid as number) ?? nextOid();
  const now = Math.floor(Date.now() / 1000);
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_order
      (oid, uid, uname, memberid, tid, sid, type, state, goodsprice, goodsprice1, goodsnum, bargainprice,
       sendprice, inspection, goodsurl, goodsname, extend, addtime, uptime, sku_name, expressno,
       item_location, ship, goodsremark, orderremark, yanhuofba, yanhuoasin, FNSKU, outid,
       dfstoremode, mark_flag, arrivetime, goodssize, goodscolor, goodsseller, goodssite, goodsid,
       supplier_shop_id, supplier_product_id, goodsimg)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?)`,
    oid,
    user.uid,
    user.uname,
    user.memberid,
    overrides.tid ?? '',
    overrides.sid ?? null,
    overrides.type ?? 1,
    overrides.state ?? 1,
    overrides.goodsprice ?? 100,
    overrides.goodsprice1 ?? 0,
    overrides.goodsnum ?? 1,
    overrides.bargainprice ?? 0,
    overrides.sendprice ?? 0,
    overrides.inspection ?? 0,
    overrides.goodsurl ?? 'https://e.com/x',
    overrides.goodsname ?? 'テスト商品',
    overrides.extend ?? null,
    overrides.addtime ?? now,
    overrides.uptime ?? now,
    overrides.sku_name ?? '',
    overrides.expressno ?? null,
    overrides.item_location ?? null,
    overrides.ship ?? 0,
    overrides.goodsremark ?? null,
    overrides.orderremark ?? null,
    overrides.yanhuofba ?? '',
    overrides.yanhuoasin ?? '',
    overrides.FNSKU ?? '',
    overrides.outid ?? null,
    overrides.dfstoremode ?? 0,
    overrides.mark_flag ?? 0,
    overrides.arrivetime ?? null,
    overrides.goodssize ?? '',
    overrides.goodscolor ?? '',
    overrides.goodsseller ?? null,
    overrides.goodssite ?? null,
    overrides.goodsid ?? null,
    overrides.supplier_shop_id ?? 0,
    overrides.supplier_product_id ?? 0,
    overrides.goodsimg ?? null,
  );
  return { oid };
}

describe('订单列表（listOrderV2 复现）', () => {
  it('普通用户：type 强制 in [1,2]，看不到代发单', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { dfflag: 0 });
      await seedOrder(tx, user, { type: 1 });
      await seedOrder(tx, user, { type: 3 });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.total).toBe(1);
        expect(result.value.rows[0]?.type).toBe(1);
      }
    });
  });

  it('dfflag 用户：type 强制 =3，看不到普通单', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { dfflag: 1 });
      await seedOrder(tx, user, { type: 1 });
      await seedOrder(tx, user, { type: 3 });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.total).toBe(1);
        expect(result.value.rows[0]?.type).toBe(3);
      }
    });
  });

  it('state=3 显示合并：在途视图包含 12（不良待确认），且行显示态 12→3', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      await seedOrder(tx, user, { state: 3 });
      const hidden = await seedOrder(tx, user, { state: 12 });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
        state: 3,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.total).toBe(2);
        const row = result.value.rows.find((r) => r.oid === hidden.oid);
        expect(row?.state).toBe(3); // 显示态转换
      }
    });
  });

  it('keyword 超过 3 词 → ORDER_KEYWORD_TOO_MANY', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
        keyword: 'a b c d',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ORDER_KEYWORD_TOO_MANY');
    });
  });

  it('keyword 商品名 like 命中', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      await seedOrder(tx, user, { goodsname: 'ユニクロエアリズム' });
      await seedOrder(tx, user, { goodsname: '無印良品' });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
        keyword: 'エアリズム',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.total).toBe(1);
    });
  });

  it('queryType=refuse：禁运视图（state<5 + item_location 非空非 MADE_IN_CHINA）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      await seedOrder(tx, user, { state: 2, item_location: '磁石 電池' });
      await seedOrder(tx, user, { state: 2, item_location: 'MADE_IN_CHINAあり' }); // 非禁运
      await seedOrder(tx, user, { state: 5, item_location: '磁石' }); // state≥5 不算

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
        queryType: 'refuse',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.total).toBe(1);
        expect(result.value.rows[0]?.itemLocation).toBe('磁石 電池');
        expect(result.value.rows[0]?.madeInChina).toBeNull();
      }
    });
  });

  it('item_location 拆分：禁运原因与中国制造标记分离', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      const o = await seedOrder(tx, user, {
        state: 2,
        item_location: '磁石 MADE_IN_CHINAあり 電池',
      });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const row = result.value.rows.find((r) => r.oid === o.oid);
        expect(row?.itemLocation).toBe('磁石 電池');
        expect(row?.madeInChina).toBe('MADE_IN_CHINAあり');
      }
    });
  });

  it('砍价展示：saved 金额 = (price−price1)×num；displayFrom 以前 before_start', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      const displayFrom = Math.floor(new Date('2026-11-01T00:00:00+09:00').getTime() / 1000);
      await seedOrder(tx, user, {
        state: 2,
        goodsprice: 100,
        goodsprice1: 80,
        goodsnum: 3,
        addtime: displayFrom + 100,
      });
      await seedOrder(tx, user, {
        state: 2,
        goodsprice: 100,
        goodsprice1: 80,
        goodsnum: 3,
        addtime: displayFrom - 100,
      });

      const result = await makeService(tx, displayFrom).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const byAmount = result.value.rows.map((r) => r.bargainStatus);
        expect(byAmount).toContain('saved');
        expect(byAmount).toContain('before_start');
        const saved = result.value.rows.find((r) => r.bargainStatus === 'saved');
        expect(saved?.bargainAmount).toBe('60.00');
      }
    });
  });

  it('markFavorite 过滤：位运算命中（favorite=1 → mark_flag 低两位 = 01）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      await seedOrder(tx, user, { mark_flag: 0b01 }); // favorite=1
      await seedOrder(tx, user, { mark_flag: 0b100 }); // arrival=1，favorite=0
      await seedOrder(tx, user, { mark_flag: 0b00 });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
        markFavorite: 1,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.total).toBe(1);
    });
  });

  it('分页：total 全量计数 + skip/take', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      for (let i = 0; i < 5; i++) await seedOrder(tx, user, { type: 1 });

      const p1 = await makeService(tx).listOrders(memberPrincipal(user.uid), { page: 1, limit: 2 });
      const p3 = await makeService(tx).listOrders(memberPrincipal(user.uid), { page: 3, limit: 2 });
      expect(p1.ok && p3.ok).toBe(true);
      if (p1.ok && p3.ok) {
        expect(p1.value.total).toBe(5);
        expect(p1.value.rows).toHaveLength(2);
        expect(p3.value.rows).toHaveLength(1);
        // oid desc 排序
        expect(p1.value.rows[0]!.oid).toBeGreaterThan(p1.value.rows[1]!.oid);
      }
    });
  });

  it('软删单不出现（OrderWithoutTrashed 口径）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      const o = await seedOrder(tx, user, { type: 1 });
      await tx.$executeRawUnsafe('UPDATE dg_order SET deleted_at = NOW() WHERE oid = ?', o.oid);

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.total).toBe(0);
    });
  });

  it('parseSkuName：sku_name 标签解析 + 空值回退 size/color', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      const tagged = await seedOrder(tx, user, {
        sku_name:
          '<font color=red>サイズ:</font><font color=green> M </font><font color=red>色:</font><font color=green>黒</font>',
      });
      const fallback = await seedOrder(tx, user, {
        sku_name: '',
        goodssize: 'L',
        goodscolor: '白',
      });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const a = result.value.rows.find((r) => r.oid === tagged.oid);
        expect(a?.goodSkus).toEqual([
          { name: 'サイズ', value: 'M' },
          { name: '色', value: '黒' },
        ]);
        const b = result.value.rows.find((r) => r.oid === fallback.oid);
        expect(b?.goodSkus).toEqual([
          { name: '尺码', value: 'L' },
          { name: '颜色', value: '白' },
        ]);
      }
    });
  });

  it('extend.platform_order_no 投影', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx);
      const o = await seedOrder(tx, user, {
        extend: JSON.stringify({ platform_order_no: 'PO-123' }),
      });

      const result = await makeService(tx).listOrders(memberPrincipal(user.uid), {
        page: 1,
        limit: 20,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.rows.find((r) => r.oid === o.oid)?.platformOrderNo).toBe('PO-123');
      }
    });
  });
});
