import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '@crossbuy/domain-order';
import { SendOrderRepository } from '../src/repository';
import {
  SendOrderServiceImpl,
  type SendOrderOrdersPort,
  type ShippingWebsitePort,
} from '../src/service';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

const now = Math.floor(Date.now() / 1000);

/** 运单行（raw INSERT：dump 必填列 uname/memberid/xiwgfei/xwdj/consignee 显式落） */
async function seedSendOrder(
  tx: Tx,
  input: {
    sid?: number;
    uid: number;
    uname: string;
    state?: number;
    otype?: number;
    sn?: string;
    freight?: number;
    serverfee?: number;
    customsfee?: number;
    remotefee?: number;
    sendprice?: number;
    comment?: string | null;
    deliveryname?: string | null;
    havefapiao?: number;
    oids?: string;
    address?: string;
  },
): Promise<number> {
  let sid = input.sid;
  if (sid === undefined) {
    const row = await tx.$queryRawUnsafe<Array<{ sid: number }>>(
      'SELECT MAX(sid) + 1 AS sid FROM dg_sendorder',
    );
    sid = Number(row[0]?.sid ?? 600001);
  }
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_sendorder (sid, uid, uname, memberid, email, oids, couponid, couponmoney, serverfee, customsfee, yishouqufee, xiwgfei, xwdj, totalfee, countmoney, areaname, addtime, uptime, state, storage, otype, dfsendaddress, dfsendname, dfsendtel, consignee, address, tel, zip, remark, country, sn, freight, remotefee, sendprice, comment, commenttime, reply, havefapiao, deliveryname)
     VALUES (?, ?, ?, '', NULL, ?, 0, 0, ?, ?, 0, 0, '', 0, 0, '', ?, ?, ?, 0, ?, '', '', '', '山田太郎', ?, '090-0000-0000', '530-0000', '', '日本', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // 占位符顺序：sid,uid,uname,oids,serverfee,customsfee,addtime,uptime,state,otype,address,sn,freight,remotefee,sendprice,comment,commenttime,reply,havefapiao,deliveryname
    sid,
    input.uid,
    input.uname,
    input.oids ?? '',
    input.serverfee ?? 0,
    input.customsfee ?? 0,
    now,
    now,
    input.state ?? 1,
    input.otype ?? 1,
    input.address ?? '大阪市北区1-1',
    input.sn ?? '',
    input.freight ?? 0,
    input.remotefee ?? 0,
    input.sendprice ?? 0,
    input.comment ?? null,
    input.comment ? now : null,
    null,
    input.havefapiao ?? 0,
    input.deliveryname ?? null,
  );
  return sid;
}

/** 订单行（raw INSERT：mark_flag/yanhuofba/type/sendprice/sid 投影面） */
async function seedOrder(
  tx: Tx,
  input: {
    uid: number;
    sid: number;
    markFlag?: number;
    yanhuofba?: string;
    type?: number;
    sendprice?: number;
  },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_order (uid, uname, memberid, tid, goodssite, type, state, goodsprice, goodsprice1, goodsnum, bargainprice, sendprice, inspection, goodsurl, goodsname, extend, addtime, uptime, sid, mark_flag, yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU, shangpin_sku, FNSKU, shangpin_fnsku, name, shangpin_name, amazon, putong, shangpin_amazon, fuzhuang, tiebiao, huanbaoz, qita)
     VALUES (?, 'shipuser', '', '', '1688', ?, 2, 100, 0, 1, 0, ?, 0, 'https://e.com/1', 'x', NULL, ?, ?, ?, ?, ?, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '')`,
    input.uid,
    input.type ?? 1,
    input.sendprice ?? 0,
    now,
    now,
    String(input.sid),
    input.markFlag ?? 0,
    input.yanhuofba ?? '',
  );
}

/** 订单端口：真实 OrderRepository（tx 绑定） */
function makeOrdersPort(tx: Tx): SendOrderOrdersPort {
  const repo = new OrderRepository(tx as never);
  return {
    listBriefBySids: (sids) => repo.listBriefBySids(tx as never, sids),
    listSidsByShipmentKeyword: (uid, keyword, isDf) =>
      repo.listSidsByShipmentKeyword(tx as never, uid, keyword, isDf),
  };
}

const shippingPort: ShippingWebsitePort = {
  resolve: (name) => (name === '佐川急便' ? 'https://tracking.sagawa.example' : null),
};

function makeService(tx: Tx): SendOrderServiceImpl {
  return new SendOrderServiceImpl(
    new SendOrderRepository(tx as never),
    makeOrdersPort(tx),
    shippingPort,
  );
}

const principal = (uid: number) => ({ kind: 'member', subject: String(uid) }) as never;

describe('会员运单列表（listSendOrder 1:1）', () => {
  it('普通用户：otype=1 强制 + 无 total；行投影（金额字符串/ISO/地址信息）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const sid = await seedSendOrder(tx, {
        uid: 777001,
        uname: 'so-user',
        otype: 1,
        freight: 12.5,
        serverfee: 3,
        customsfee: 2,
        remotefee: 1.5,
        sendprice: 10,
      });
      const result = await makeService(tx).listMemberSendOrders(
        principal(777001),
        { page: 1, limit: 20 },
        false,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.page).toBe(1);
      expect('total' in result.value).toBe(false); // S29：旧面不回 total
      const row = result.value.rows.find((r) => r.sid === sid)!;
      expect(row).toBeDefined();
      expect(row.state).toBe(1);
      expect(row.freight).toBe('12.5');
      // 合计 = 12.5 + 3 + 2 + 1.5 + 10（sendprice>0 直接用列值）
      expect(row.totalSendFee).toBe('29.00');
      expect(row.addressInfo.consignee).toBe('山田太郎');
      expect(row.addressInfo.country).toBe('日本');
      expect(row.createdAt).toContain('T');
    });
  });

  it('DF 用户：otype=3 强制 + 默认可见态 [1,2,3,5]；普通用户看不到 DF 运单', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const uid = 777002;
      await seedSendOrder(tx, { uid, uname: 'so-df', otype: 3, state: 6 }); // 待审核——DF 默认不可见
      await seedSendOrder(tx, { uid, uname: 'so-df', otype: 3, state: 2 });
      await seedSendOrder(tx, { uid: uid, uname: 'so-df', otype: 1, state: 2 }); // 普通单
      const svc = makeService(tx);

      const dfResult = await svc.listMemberSendOrders(principal(uid), { page: 1, limit: 20 }, true);
      expect(dfResult.ok).toBe(true);
      if (dfResult.ok) {
        const states = dfResult.value.rows.map((r) => r.state);
        expect(states).toContain(2);
        expect(states).not.toContain(6); // 默认可见态不含 6
        // otype=1 的运单对 DF 不可见（otype 强制 3）
        expect(dfResult.value.rows.every((r) => r.state !== undefined)).toBe(true);
      }

      const normalResult = await svc.listMemberSendOrders(
        principal(999888),
        { page: 1, limit: 20 },
        false,
      );
      expect(normalResult.ok).toBe(true);
      if (normalResult.ok) expect(normalResult.value.rows).toHaveLength(0); // 只看自己 uid
    });
  });

  it('keyword：`数字/数字` sid 精确路径 + 五列 like', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const uid = 777003;
      const sidA = await seedSendOrder(tx, { uid, uname: 'so-kw', sn: 'ABC#DEF' });
      const sidB = await seedSendOrder(tx, {
        uid,
        uname: 'so-kw',
        sn: 'XYZ',
        address: '東京都渋谷区',
      });
      const svc = makeService(tx);

      const bySid = await svc.listMemberSendOrders(
        principal(uid),
        { page: 1, limit: 20, keyword: `${sidA}/${sidB}` },
        false,
      );
      expect(bySid.ok).toBe(true);
      if (bySid.ok)
        expect(bySid.value.rows.map((r) => r.sid).sort((a, b) => a - b)).toEqual(
          [sidA, sidB].sort((a, b) => a - b),
        );

      const byAddr = await svc.listMemberSendOrders(
        principal(uid),
        { page: 1, limit: 20, keyword: '渋谷' },
        false,
      );
      expect(byAddr.ok).toBe(true);
      if (byAddr.ok) expect(byAddr.value.rows.map((r) => r.sid)).toEqual([sidB]);
    });
  });

  it('airbills：空表 → sn # 拆分合成；非空 → sn 去重', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const uid = 777004;
      const sidEmpty = await seedSendOrder(tx, { uid, uname: 'so-air', sn: 'AA#BB' });
      const sidFull = await seedSendOrder(tx, { uid, uname: 'so-air', sn: 'FALLBACK' });
      await tx.$executeRawUnsafe(
        'INSERT INTO dg_airbill (sendid, sn, trace_info) VALUES (?, ?, ?)',
        sidFull,
        'T1',
        'tokyo',
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO dg_airbill (sendid, sn, trace_info) VALUES (?, ?, ?)',
        sidFull,
        'T2',
        'osaka',
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO dg_airbill (sendid, sn, trace_info) VALUES (?, ?, ?)',
        sidFull,
        'T2',
        'dup',
      );

      const result = await makeService(tx).listMemberSendOrders(
        principal(uid),
        { page: 1, limit: 20 },
        false,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rowEmpty = result.value.rows.find((r) => r.sid === sidEmpty)!;
      expect(rowEmpty.airbills.map((a) => a.sn)).toEqual(['AA', 'BB']); // 合成
      expect(rowEmpty.airbills[0]!.traceInfo).toBeNull();
      const rowFull = result.value.rows.find((r) => r.sid === sidFull)!;
      expect(rowFull.airbills).toHaveLength(2); // T2 去重
      expect(rowFull.airbills.map((a) => a.sn)).toEqual(['T1', 'T2']);
    });
  });

  it('订单面投影：arrival 位/FBA/domestic sendprice 兜底（列值 0 → 活跃订单汇总）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const uid = 777005;
      const sid = await seedSendOrder(tx, {
        uid,
        uname: 'so-proj',
        sendprice: 0,
        deliveryname: '佐川急便',
      });
      await seedOrder(tx, {
        uid,
        sid,
        markFlag: 0b0100,
        yanhuofba: 'FBA',
        type: 1,
        sendprice: 7.25,
      });
      const result = await makeService(tx).listMemberSendOrders(
        principal(uid),
        { page: 1, limit: 20 },
        false,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.value.rows.find((r) => r.sid === sid)!;
      expect(row.arrival).toBe(1); // mark_flag arrival 位非 0
      expect(row.fba).toBe(true);
      // domestic = 0 → 订单 sendprice 7.25 兜底
      expect(Number(row.totalSendFee)).toBeCloseTo(7.25, 2);
      expect(row.shippingWebsiteUrl).toBe('https://tracking.sagawa.example'); // 端口命中
    });
  });

  it('comment JSON 解析 + shippingWebsiteUrl Google 兜底', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const uid = 777006;
      await seedSendOrder(tx, {
        uid,
        uname: 'so-cmt',
        comment: JSON.stringify({ comment: '很好' }),
        deliveryname: '日本邮政',
      });
      await seedSendOrder(tx, { uid, uname: 'so-cmt', comment: 'not-json', deliveryname: null });
      const result = await makeService(tx).listMemberSendOrders(
        principal(uid),
        { page: 1, limit: 20 },
        false,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rows = result.value.rows;
      expect(rows.find((r) => r.comment === '很好')).toBeDefined();
      const badRow = rows.find((r) => r.deliveryName === null)!;
      expect(badRow.comment).toBe(''); // 非 JSON = ''
      expect(badRow.shippingWebsiteUrl).toBe(''); // deliveryname 空 = ''
      const goodRow = rows.find((r) => r.deliveryName === '日本邮政')!;
      expect(goodRow.shippingWebsiteUrl).toContain('google.co.jp'); // 端口 null → Google 兜底
    });
  });
});
