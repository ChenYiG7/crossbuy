import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import { Webhook1688LogisticsService, type OauthUserPort, type SendOrderPort } from '../src/webhook-1688-logistics';
import { MemberRepository, MemberServiceImpl } from '@crossbuy/domain-member';
import { SendOrderRepository, SendOrderServiceImpl } from '@crossbuy/domain-send-order';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

const APPID = 'test-logistics-appid';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    action: 'INBOUND_NOTIFY',
    buyerUserParam: { buyerUserId: 'buyer-1', username: 'wxbuyer', phone: '13800000000' },
    tradeOrderId: `T${Math.floor(Math.random() * 1e12)}`,
    mailNo: 'SF999888777',
    cpCode: 'SF',
    receiverAddress: { regionName: '大阪府', detailAddress: '浪速区1-1' },
    itemList: [
      { auctionUrl: 'https://detail.1688.com/1.html', auctionTitle: 'テスト商品A', pictureUrl: 'https://img/1.jpg', quantity: 2, skuName: '颜色:红' },
      { auctionUrl: 'https://detail.1688.com/2.html', auctionTitle: 'テスト商品B', quantity: 1 },
    ],
    ...overrides,
  };
}

/** member 端口：真实 MemberServiceImpl（tx 绑定）——建档分支走外层事务透传 */
function makeMemberPort(tx: Tx): OauthUserPort {
  const service = new MemberServiceImpl(
    new MemberRepository(tx as never),
    { verify: async () => true },
    { attempt: async () => ({ allowed: true, remaining: 5 }), reset: async () => undefined },
  );
  return { findOrCreateOauthUser: (input) => service.findOrCreateOauthUser(input) };
}

function makeSendOrderPort(tx: Tx): SendOrderPort {
  const service = new SendOrderServiceImpl(new SendOrderRepository(tx as never));
  return { createFor1688Logistics: (input) => service.createFor1688Logistics(input, tx) };
}

function makeService(tx: Tx, overrides: { forward?: (m: unknown) => Promise<void> } = {}): Webhook1688LogisticsService {
  return new Webhook1688LogisticsService({
    repository: new OrderRepository(tx as never),
    appid: APPID,
    memberService: makeMemberPort(tx),
    sendOrderService: makeSendOrderPort(tx),
    ...overrides,
  });
}

describe('1688 物流建档 webhook（webhookFor1688LogisticsProvider 1:1）', () => {
  it('oauth 未命中 → 建档（usetype=5 + oauth_login 绑定 + md5 密码）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const msg = makeMessage();
      const result = await makeService(tx).consume(msg);

      expect(result.outcome).toBe('created_orders');
      expect(result.sid).not.toBeNull();
      expect(result.oids).toHaveLength(2);

      const login = await tx.v2_oauth_login.findFirst({
        where: { appid: APPID, openid: 'buyer-1' },
      });
      expect(login).not.toBeNull();
      const user = await tx.dg_users.findUnique({ where: { uid: login!.uid }, select: { uname: true, usetype: true, state: true, password: true, memberid: true } });
      expect(user?.usetype).toBe(5); // USE_TYPE_5「1688转运」
      expect(user?.state).toBe(1); // USER_STATE_1
      expect(user?.password).toMatch(/^[a-f0-9]{32}$/); // md5
      expect(user?.memberid).toBeNull(); // 旧 TODO「分配 memberId」未实现
    });
  });

  it('oauth 命中 → 复用用户不建档', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      // 预置绑定用户
      const user = await tx.dg_users.create({
        data: { uname: 'wxbuyer', password: 'x', card: '', state: 1, usetype: 5, validity: 0 },
        select: { uid: true },
      });
      await tx.v2_oauth_login.create({ data: { appid: APPID, openid: 'buyer-1', uid: user.uid } });

      const before = await tx.v2_oauth_login.count({ where: { appid: APPID } });
      const result = await makeService(tx).consume(makeMessage());
      expect(result.outcome).toBe('created_orders');
      const after = await tx.v2_oauth_login.count({ where: { appid: APPID } });
      expect(after).toBe(before); // 无新建档（仍 1 条绑定）
    });
  });

  it('uname 撞名 → 追加 rand(10,99) 后缀（只追一次）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      await tx.dg_users.create({
        data: { uname: 'wxbuyer', password: 'x', card: '', state: 1, usetype: 5, validity: 0 },
        select: { uid: true },
      });
      const result = await makeService(tx).consume(makeMessage());
      expect(result.outcome).toBe('created_orders');
      const login = await tx.v2_oauth_login.findFirst({ where: { appid: APPID, openid: 'buyer-1' } });
      const user = await tx.dg_users.findUnique({ where: { uid: login!.uid }, select: { uname: true } });
      expect(user?.uname).toMatch(/^wxbuyer\d{2}$/);
      expect(user?.uname).not.toBe('wxbuyer');
    });
  });

  it('无订单 → 直建转运订单（state=3 入库态 / type=2 / goodssite=1688）+ 运单 + sid 回写', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const msg = makeMessage();
      const result = await makeService(tx).consume(msg);

      const orders = await tx.dg_order.findMany({
        where: { tid: msg.tradeOrderId },
        select: { oid: true, state: true, type: true, goodssite: true, sid: true, expressno: true, sku_name: true, goodsnum: true },
        orderBy: { oid: 'asc' },
      });
      expect(orders).toHaveLength(2);
      expect(orders.every((o) => o.state === 3)).toBe(true); // STATE_SEND 建单即入库
      expect(orders.every((o) => o.type === 2)).toBe(true); // ORDER_TYPE_ZHUANYUN
      expect(orders.every((o) => o.goodssite === '1688')).toBe(true);
      expect(orders.every((o) => o.expressno === msg.mailNo)).toBe(true);
      expect(orders[0]!.sku_name).toBe('颜色:红');

      const sid = result.sid!;
      const sendOrder = await tx.dg_sendorder.findUnique({
        where: { sid },
        select: { state: true, otype: true, oids: true, address: true, country: true, totalfee: true },
      });
      expect(sendOrder?.state).toBe(1); // STATE_WAITING
      expect(sendOrder?.otype).toBe(3); // OTYPE_3
      expect(sendOrder?.address).toBe('浪速区1-1');
      expect(sendOrder?.country).toBe('大阪府');
      // sid 回写到全部订单
      expect(orders.every((o) => o.sid === String(sid))).toBe(true);
    });
  });

  it('已有订单 → 不建运单（outcome=existing_orders）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const msg = makeMessage();
      // 先跑一遍建档
      await makeService(tx).consume(msg);
      // 再跑一遍：订单已存在
      const result = await makeService(tx).consume(msg);
      expect(result.outcome).toBe('existing_orders');
      expect(result.sid).toBeNull();
      // 运单只有 1 张
      const login = await tx.v2_oauth_login.findFirst({ where: { appid: APPID, openid: 'buyer-1' } });
      const sendOrders = await tx.dg_sendorder.findMany({ where: { uid: login!.uid }, select: { sid: true } });
      expect(sendOrders).toHaveLength(1);
    });
  });

  it('expressno 多单号合并：首单集合为基准，已含 mailNo 跳过', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const msg = makeMessage({ mailNo: 'SF-A' });
      await makeService(tx).consume(msg);
      // 第二个运单号 → 追加
      const result2 = await makeService(tx).consume(makeMessage({ tradeOrderId: msg.tradeOrderId, mailNo: 'SF-B' }));
      expect(result2.outcome).toBe('existing_orders');
      const order = await tx.dg_order.findFirst({ where: { tid: msg.tradeOrderId }, select: { expressno: true } });
      expect(order?.expressno).toBe('SF-A SF-B');
      // 同单号重发 → 不重复
      await makeService(tx).consume(makeMessage({ tradeOrderId: msg.tradeOrderId, mailNo: 'SF-B' }));
      const order2 = await tx.dg_order.findFirst({ where: { tid: msg.tradeOrderId }, select: { expressno: true } });
      expect(order2?.expressno).toBe('SF-A SF-B');
    });
  });

  it('入库登记 firstOrCreate 幂等（同 mailNo 复用 arrival）+ pivot 唯一忽略', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const msg = makeMessage();
      const r1 = await makeService(tx).consume(msg);
      const r2 = await makeService(tx).consume(makeMessage({ tradeOrderId: msg.tradeOrderId }));
      expect(r2.arrivalId).toBe(r1.arrivalId); // 复用
      const arrivals = await tx.v2_logistic_domestic.findMany({
        where: { expressno: msg.mailNo },
        select: { id: true, state: true, provider_code: true },
      });
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0]!.state).toBe(1); // STATE_SEND
      expect(arrivals[0]!.provider_code).toBe('SF');
      // pivot 唯一（2 单 × 2 次 consume = 仍 2 行）
      const pivots = await tx.v2_relation_order_and_logistic_domestic.findMany({
        where: { logistic_domestic_id: BigInt(r1.arrivalId) },
      });
      expect(pivots).toHaveLength(2);
    });
  });

  it('契约缺字段 → parse 抛（路由转 500 重试语义）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const svc = makeService(tx);
      await expect(svc.consume({ buyerUserParam: {} })).rejects.toThrow();
    });
  });
});
