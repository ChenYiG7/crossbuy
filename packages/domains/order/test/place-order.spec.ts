import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import {
  batchProcessLockKey,
  charCv,
  PlaceOrderService,
  skuLockSuffix,
  toolsRemoveBlank,
  type DaifaSendOrderPort,
  type FeeDeductPreview,
  type GoodsPriceRefreshPort,
  type PlaceOrderBenefitPort,
  type PlaceOrderSideEffectPort,
  type ProcessLockPort,
  type SkuTranslationPort,
} from '../src/place-order';
import { SendOrderRepository, SendOrderServiceImpl } from '@crossbuy/domain-send-order';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

/**
 * dg_cart 必填空串列（information_schema 核实；与 cart.spec.ts 同一份清单）。
 * 占位符顺序注释锁定——上上轮「41 列对 37 值」的教训。
 */
const CART_EMPTY_COLS =
  'yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU, FNSKU, name, amazon, putong, fuzhuang, tiebiao, huanbaoz, qita, var1, var2, var3, var4, var5, var6, var7';

// 基址随机高位：dump 是旧库尾切片，低位 id 撞存量行
let nextGid = 99_100_000 + Math.floor(Math.random() * 100_000);
const NEXT_ID = () => nextGid++;

/** dg_users（下单链路：money/dfflag/utype/validity/dffee/memberid/belong_company） */
async function seedUser(tx: Tx, overrides: Record<string, unknown> = {}) {
  const uname = `po_${Math.random().toString(36).slice(2, 9)}`;
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_users (uname, password, card, memberid, email, money, dfflag, utype, validity, dffee, belong_company, state)
     VALUES (?, 'x', 'test', ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
    uname,
    overrides.memberid ?? '',
    overrides.money ?? 1000,
    overrides.dfflag ?? 0,
    overrides.utype ?? 0,
    overrides.validity ?? 0,
    overrides.dffee ?? 10,
    overrides.belong_company ?? '购霸',
  );
  const row = await tx.dg_users.findFirst({ where: { uname }, select: { uid: true, uname: true } });
  expect(row).toBeTruthy();
  return { uid: Number(row!.uid), uname: row!.uname };
}

/**
 * dg_cart 夹具：**列数组与值数组同序构造**（旧「手写列串 vs 手写占位符串」必错——
 * 上上轮 41 列对 37 值、本轮 26 列对 25 值，两次都是同一类事故；这里让 SQL 自己数）。
 */
const CART_DATA_COLS = [
  'gid', 'uid', 'uname', 'supplier_product_id', 'type', 'goodsurl', 'goodsname', 'goodsprice',
  'goodsimg', 'offer_price', 'retail_price', 'one_piece_price', 'sendprice', 'goodsnum', 'min_order_quantity',
  'goodssize', 'goodscolor', 'goodsseller', 'goodssite', 'goodsid', 'shangpin_sku', 'sku_name',
  'expressno', 'proprice', 'addtime', 'add_from', 'add_from_memo',
] as const;

async function seedCart(tx: Tx, input: Record<string, unknown>): Promise<number> {
  const gid = NEXT_ID();
  const values: unknown[] = [
    gid,
    input.uid,
    input.uname ?? 'cart_uname', // 旧 order.uname 搬的是 **cart.uname**（不是 user.uname）
    input.supplier_product_id ?? 0,
    input.type ?? 1,
    input.goodsurl ?? 'https://e.com/1',
    input.goodsname ?? '\u30c6\u30b9\u30c8\u5546\u54c1',
    input.goodsprice ?? 100,
    input.goodsimg ?? null,
    input.offer_price ?? 0,
    input.retail_price ?? null,
    input.one_piece_price ?? 0,
    input.sendprice ?? 0,
    input.goodsnum ?? 1,
    input.min_order_quantity ?? 2,
    input.goodssize ?? null,
    input.goodscolor ?? null,
    input.goodsseller ?? 'shopA',
    input.goodssite ?? '1688',
    input.goodsid ?? 'g1',
    input.shangpin_sku ?? '',
    input.sku_name ?? '',
    input.expressno ?? '',
    input.proprice ?? null,
    Math.floor(Date.now() / 1000),
    input.add_from ?? 1,
    input.add_from_memo ?? '',
  ];
  const literals = CART_EMPTY_COLS.split(',').map(() => "' '");
  const sql = `INSERT INTO dg_cart (${[...CART_DATA_COLS, ...CART_EMPTY_COLS.split(',').map((c) => c.trim())].join(', ')})
     VALUES (${[...CART_DATA_COLS.map(() => '?'), ...literals].join(', ')})`;
  await tx.$executeRawUnsafe(sql, ...values);
  return gid;
}

/** v2_supplier_product（阶梯价/混批规则宿主） */
async function seedProduct(tx: Tx, input: Record<string, unknown>): Promise<number> {
  const id = NEXT_ID();
  await tx.$executeRawUnsafe(
    `INSERT INTO v2_supplier_product (id, shop_id, platform, goods_id, goods_name, price_range, min_order_quantity,
       seller_mix_setting, one_piece_free_postage, created_at)
     VALUES (?, ?, '1688', ?, ?, ?, ?, ?, ?, NOW())`,
    id, input.shop_id ?? 0, input.goods_id ?? `p${id}`, input.goods_name ?? '商品',
    input.price_range ? JSON.stringify(input.price_range) : null,
    input.min_order_quantity ?? 2, input.seller_mix_setting ?? null, input.one_piece_free_postage ?? 0,
  );
  return id;
}

/** 进程内闸门（测试用；与组合根同语义） */
function makeLockPort(): ProcessLockPort & { keys: Map<string, number> } {
  const keys = new Map<string, number>();
  return {
    keys,
    async has(key) {
      const until = keys.get(`c:${key}`);
      return until !== undefined && until > Date.now();
    },
    async put(key, ttl) {
      keys.set(`c:${key}`, Date.now() + ttl * 1000);
    },
    async acquire(key, ttl) {
      const until = keys.get(`l:${key}`);
      if (until !== undefined && until > Date.now()) return false;
      keys.set(`l:${key}`, Date.now() + ttl * 1000);
      return true;
    },
    async release(key) {
      keys.delete(`l:${key}`);
    },
  };
}

interface HarnessOptions {
  feeDeductPreviewEnabled?: boolean;
  preview?: FeeDeductPreview | null;
}

function makeService(tx: Tx, opts: HarnessOptions = {}) {
  const repository = new OrderRepository(tx as never);
  const lockPort = makeLockPort();
  const sideEffects = {
    emails: [] as Array<{ uid: number; flag: number | null; total: number }>,
    mns: [] as Array<{ uid: number; orderIds: number[] }>,
    completion: [] as number[],
    translate: [] as number[],
  };
  const used: number[] = [];
  const goodsPriceRefreshPort: GoodsPriceRefreshPort = { refresh: async () => undefined };
  const skuTranslationPort: SkuTranslationPort = { attributesFor: async () => null };
  const benefitPort: PlaceOrderBenefitPort = {
    previewFeeDeduct: async () => (opts.feeDeductPreviewEnabled ? opts.preview ?? null : null),
    useFeeDeductBenefit: async (_uid, _money, orderIds) => {
      used.push(...orderIds);
    },
  };
  const sideEffectsPort: PlaceOrderSideEffectPort = {
    enqueueCartToOrderEmail: async (i) => {
      sideEffects.emails.push(i);
    },
    enqueueOrderCreated: async (i) => {
      sideEffects.mns.push({ uid: i.uid, orderIds: i.orderIds });
    },
    enqueueCompletionGoodsInfo: async (oid) => {
      sideEffects.completion.push(oid);
    },
    enqueueTranslateOrderGoodsInfo: async (oid) => {
      sideEffects.translate.push(oid);
    },
  };
  // 一件代发运单走 send-order 域真实现（dg_sendorder 属主；跨域测试 alias 已在 vitest.config）
  const sendOrderPort: DaifaSendOrderPort = new SendOrderServiceImpl(
    new SendOrderRepository(tx as never),
    { listBriefBySids: async () => new Map(), listSidsByShipmentKeyword: async () => [] },
    { resolve: () => null },
  );
  const service = new PlaceOrderService({
    repository,
    runTx: (fn) => fn(tx as never),
    goodsPriceRefreshPort,
    skuTranslationPort,
    benefitPort,
    lockPort,
    sideEffects: sideEffectsPort,
    sendOrderPort,
    feeDeductPreviewEnabled: opts.feeDeductPreviewEnabled ?? false,
    utypeCharged: 1,
    skuCooldownSeconds: 30,
    processLockSeconds: 300,
    clock: () => new Date('2026-10-17T21:00:00+08:00'),
  });
  return { service, repository, lockPort, sideEffects, used };
}

const member = (uid: number) => ({ kind: 'member', subject: String(uid) }) as never;

describe('下单主体（CreateOrderFromCartService + cartToOrder + payOrder 1:1）', () => {
  it('代购下单：建单 + 扣款（货款 + ceil 5% 服务费）+ 删车 + extend 落抵扣 + 事务后副作用', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { money: 1000 });
      const gid = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 2, goodsimg: 'https://e.com/1.jpg' });
      const { service, sideEffects } = makeService(tx);

      const result = await service.placeOrders(member(user.uid), { ids: String(gid) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.orderIds).toHaveLength(1);
      expect(result.value.totalMoney).toBe('210.00'); // 200 + ceil(200*0.05*100)/100
      expect(result.value.sendOrderId).toBeNull();

      const oid = result.value.orderIds[0]!;
      const order = await tx.dg_order.findUnique({
        where: { oid },
        select: { state: true, type: true, goodsprice: true, goodsnum: true, sendprice: true, uname: true, memberid: true, belong_company: true, extend: true, add_from: true, sku_name: true, goodsname: true },
      });
      expect(order?.state).toBe(1); // STATE_WAIT_CREATE
      expect(order?.type).toBe(1);
      expect(order?.goodsprice).toBe(100);
      expect(order?.sendprice).toBe(0); // 非转运运费归零
      expect(order?.uname).toBe('cart_uname'); // 旧 cartToOrder 搬的是 **cart.uname**，不是 user.uname
      expect(order?.belong_company).toBe('购霸'); // getBelongCompany 枚举命中
      // countMoney 的内存态副作用 → order.extend → payOrder 读回
      expect(order?.extend).toBe('{"deducted_service_fee":0}');

      const rec = await tx.dg_record.findFirst({ where: { uid: user.uid, oid }, select: { money: true, accountmoney: true, action: true, ordflag: true, type: true, remark: true, extend: true } });
      expect(Number(rec?.money)).toBe(-210);
      expect(Number(rec?.accountmoney)).toBe(790);
      expect(rec?.action).toBe(1); // RECORD_ACTION_1
      expect(rec?.ordflag).toBe(1); // DG
      expect(rec?.type).toBe(1); // TYPE_DECR
      expect(rec?.remark).toContain('オーダーID:');

      const after = await tx.dg_users.findUnique({ where: { uid: user.uid }, select: { money: true } });
      expect(Number(after?.money)).toBe(790);
      const cartLeft = await tx.dg_cart.findUnique({ where: { gid }, select: { gid: true } });
      expect(cartLeft).toBeNull();

      // 事务后副作用：邮件 + MNS + 翻译 Job（有图有店铺 → 不投补全 Job）
      expect(sideEffects.emails).toEqual([{ uid: user.uid, flag: 0, total: 210 }]);
      expect(sideEffects.mns).toHaveLength(1);
      expect(sideEffects.translate).toEqual([oid]);
      expect(sideEffects.completion).toEqual([]);
    });
  });

  it('余额不足：整单失败（余额守卫在建单前），不建单不扣款不删车', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { money: 100 });
      const gid = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 2, goodsimg: 'https://e.com/1.jpg' });
      const { service, sideEffects } = makeService(tx);

      const result = await service.placeOrders(member(user.uid), { ids: String(gid) });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('ORDER_INSUFFICIENT_BALANCE');

      const orders = await tx.dg_order.findMany({ where: { uid: user.uid }, select: { oid: true } });
      expect(orders).toHaveLength(0);
      expect(await tx.dg_cart.findUnique({ where: { gid }, select: { gid: true } })).not.toBeNull();
      expect(sideEffects.emails).toHaveLength(0);
    });
  });

  it('归属守卫 + 类型混装守卫（旧 handle() 顺序 1:1）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const owner = await seedUser(tx, { money: 1000 });
      const other = await seedUser(tx, { money: 1000 });
      const gid = await seedCart(tx, { uid: owner.uid, type: 1 });
      const { service } = makeService(tx);

      // 别人的购物车装载得到但归属不符 → NO_PERMISSIONS
      const denied = await service.placeOrders(member(other.uid), { ids: String(gid) });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe('NO_PERMISSIONS');

      // 代购 + 代发混装 → type error!
      const gidDaifa = await seedCart(tx, { uid: owner.uid, type: 3, goodsprice: 50, goodsnum: 1 });
      const mixed = await service.placeOrders(member(owner.uid), { ids: `${gid},${gidDaifa}` });
      expect(mixed.ok).toBe(false);
      if (!mixed.ok) expect(mixed.error.code).toBe('ORDER_TYPE_MIXED');

      // 空 ids / 不存在的 gid → CART_NOT_FOUND
      const missing = await service.placeOrders(member(owner.uid), { ids: '999999999' });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error.code).toBe('CART_NOT_FOUND');
    });
  });

  it('一件代发：回写发件信息 + 建运单 + sid/dfstoremode 落单 + oids 回写 + 扣款 (单价+dffee)×件数', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { money: 1000, dfflag: 1, dffee: 10 });
      const gid = await seedCart(tx, { uid: user.uid, type: 3, goodsprice: 50, goodsnum: 2 });
      const { service } = makeService(tx);

      const result = await service.placeOrders(member(user.uid), {
        ids: String(gid),
        storeMode: 0,
        consignee: '山田太郎',
        address: '東京都港区1-1-1',
        tel: '090-1234-5678',
        zip: '100-0001',
        remark: 'よろしく',
        country: '日本',
        deliveryname: 'EMS',
        sendAddress: '中国浙江省义乌市',
        sendTel: '0579-0000',
        sendName: '張三',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalMoney).toBe('120.00'); // (50+10)*2
      expect(result.value.sendOrderId).not.toBeNull();
      const sid = result.value.sendOrderId!;

      const order = await tx.dg_order.findUnique({
        where: { oid: result.value.orderIds[0]! },
        select: { sid: true, dfstoremode: true, state: true, type: true, sendprice: true },
      });
      expect(order?.sid).toBe(String(sid));
      expect(order?.dfstoremode).toBe(0);
      expect(order?.type).toBe(3);
      expect(order?.sendprice).toBe(0);

      const so = await tx.dg_sendorder.findUnique({
        where: { sid },
        select: { otype: true, state: true, consignee: true, address: true, tel: true, zip: true, remark: true, country: true, deliveryname: true, dfsendaddress: true, dfsendname: true, dfsendtel: true, oids: true, uid: true },
      });
      expect(so?.otype).toBe(3); // OTYPE_3
      expect(so?.state).toBe(1); // STATE_WAITING
      expect(so?.consignee).toBe('山田太郎');
      expect(so?.country).toBe('日本');
      expect(so?.deliveryname).toBe('EMS');
      expect(so?.dfsendaddress).toBe('中国浙江省义乌市');
      expect(so?.dfsendname).toBe('張三');
      expect(so?.oids).toBe(result.value.orderIds.join(','));

      // 发件信息回写会员
      const u = await tx.dg_users.findUnique({ where: { uid: user.uid }, select: { dfsendaddress: true, dfsendtel: true, dfsendname: true, money: true } });
      expect(u?.dfsendaddress).toBe('中国浙江省义乌市');
      expect(u?.dfsendtel).toBe('0579-0000');
      expect(u?.dfsendname).toBe('張三');
      expect(Number(u?.money)).toBe(880);

      // dfflag=1 → addMoney 强制 ordflag=3（旧 addMoney 矫正逻辑）
      const rec = await tx.dg_record.findFirst({ where: { uid: user.uid, oid: result.value.orderIds[0]! }, select: { money: true, ordflag: true, action: true } });
      expect(Number(rec?.money)).toBe(-120);
      expect(rec?.ordflag).toBe(3);
      expect(rec?.action).toBe(1);
    });
  });

  it('转运：有单号 state=3 + 建入库登记；无单号 state=2；转运不扣款', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { money: 1000 });
      const gid1 = await seedCart(tx, { uid: user.uid, type: 2, goodsprice: 30, goodsnum: 1, sendprice: 5, expressno: 'SF-TR-1' });
      const gid2 = await seedCart(tx, { uid: user.uid, type: 2, goodsprice: 40, goodsnum: 1, expressno: '' });
      const { service } = makeService(tx);

      const result = await service.placeOrders(member(user.uid), { ids: `${gid1},${gid2}` });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // ⚠ 旧 Cart::countMoney 的 switch 只处理代购/代发——转运不进任何分支 → totalMoney = 0
      //   （旧 CreateOrderMutation 返回值对转运确实为 0；payOrder 也不扣款。登记 S36）
      expect(result.value.totalMoney).toBe('0.00');

      const oids = result.value.orderIds;
      const o1 = await tx.dg_order.findUnique({ where: { oid: oids[0]! }, select: { state: true, type: true, sendprice: true } });
      expect(o1?.state).toBe(3); // STATE_SEND
      expect(o1?.sendprice).toBe(5); // 转运保留运费
      const o2 = await tx.dg_order.findUnique({ where: { oid: oids[1]! }, select: { state: true } });
      expect(o2?.state).toBe(2); // STATE_PAID（无单号）

      const arrivals = await tx.v2_logistic_domestic.findMany({ where: { expressno: 'SF-TR-1' }, select: { id: true, state: true, provider_code: true } });
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0]?.state).toBe(1);
      const pivots = await tx.v2_relation_order_and_logistic_domestic.findMany({ where: { oid: BigInt(oids[0]!) } });
      expect(pivots.length).toBeGreaterThanOrEqual(1);

      // 转运 payOrder 不扣款
      const recs = await tx.dg_record.findMany({ where: { uid: user.uid }, select: { money: true } });
      expect(recs).toHaveLength(0);
      const u = await tx.dg_users.findUnique({ where: { uid: user.uid }, select: { money: true } });
      expect(Number(u?.money)).toBe(1000);
    });
  });

  it('付费会员（utype=1 + validity≥今日）：服务费归零，只扣货款', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const future = Math.floor(new Date('2026-12-31T00:00:00+08:00').getTime() / 1000);
      const user = await seedUser(tx, { money: 1000, utype: 1, validity: future });
      const gid = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 2 });
      const { service } = makeService(tx);

      const result = await service.placeOrders(member(user.uid), { ids: String(gid) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalMoney).toBe('200.00');
      const rec = await tx.dg_record.findFirst({ where: { uid: user.uid }, select: { money: true, accountmoney: true } });
      expect(Number(rec?.money)).toBe(-200);
      expect(Number(rec?.accountmoney)).toBe(800);
    });
  });

  it('权益抵扣：extend.deducted_service_fee 生效 + 核销回调 + 缺图时投补全 Job', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { money: 1000 });
      const gid = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 2, goodsimg: null });
      const { service, sideEffects, used } = makeService(tx, {
        feeDeductPreviewEnabled: true,
        preview: { canDeduct: 5, maxDeduct: 5, benefitId: 77 },
      });

      const result = await service.placeOrders(member(user.uid), { ids: String(gid) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const order = await tx.dg_order.findUnique({ where: { oid: result.value.orderIds[0]! }, select: { extend: true, goodsimg: true } });
      expect(order?.extend).toBe('{"deducted_service_fee":5}');
      // 服务费 10 − 抵扣 5 = 5 → 实付 205
      const rec = await tx.dg_record.findFirst({ where: { uid: user.uid }, select: { money: true } });
      expect(Number(rec?.money)).toBe(-205);
      expect(used).toEqual(result.value.orderIds);
      // 1688 + 缺图 → 补全 Job
      expect(sideEffects.completion).toEqual(result.value.orderIds);
    });
  });

  it('1688 阶梯价回写购物车并按阶梯价计费；同规格 30s 内二次下单被冷却拦停', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const user = await seedUser(tx, { money: 1000 });
      const productId = await seedProduct(tx, {
        price_range: [
          { startQuantity: 1, price: 80 },
          { startQuantity: 10, price: 70 },
        ],
        min_order_quantity: 1,
      });
      const gid = await seedCart(tx, {
        uid: user.uid,
        type: 1,
        goodsprice: 100,
        goodsnum: 1,
        goodssite: '1688',
        supplier_product_id: productId,
      });
      const { service } = makeService(tx);

      const first = await service.placeOrders(member(user.uid), { ids: String(gid) });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const order = await tx.dg_order.findUnique({ where: { oid: first.value.orderIds[0]! }, select: { goodsprice: true } });
      expect(order?.goodsprice).toBe(80); // 阶梯价回写后按 80 计费
      // 100 → 服务费 ceil(80*0.05*100)/100 = 4 → 84
      expect(first.value.totalMoney).toBe('84.00');

      // 同 goodsid + 同 sku → 30s 冷却命中（旧 Cache::has）
      const gid2 = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 1, goodssite: '1688', goodsid: 'g1' });
      const second = await service.placeOrders(member(user.uid), { ids: String(gid2) });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('ORDER_SKU_CREATING');
    });
  });

  it('纯函数：charCv / toolsRemoveBlank / 锁键（旧字面量 1:1）', () => {
    // 顺序敏感：* / " / ; 先删除，< > 后转义
    expect(charCv('a*b;c"d<e>')).toBe('abcd&lt;e&gt;');
    expect(charCv('a&amp;b&nbsp;c')).toBe('a&b c');
    expect(charCv('x')).toBe('x');
    // PHP 顺序：先删 &nbsp; → 再把 \u00A0 转空格 → trim
    expect(toolsRemoveBlank('  a\u00A0b&nbsp;c  ')).toBe('a bc');
    // 锁键：shangpin_sku 优先；空则 md5(去空白 sku_name)
    const withSku = skuLockSuffix(7, { goodsid: '123', shangpin_sku: ' SK-1 ', sku_name: '' });
    expect(withSku.startsWith('7_')).toBe(true);
    expect(withSku).toBe(skuLockSuffix(7, { goodsid: '123', shangpin_sku: 'SK-1', sku_name: 'zzz' }));
    expect(skuLockSuffix(7, { goodsid: '123', shangpin_sku: '', sku_name: 'a b' })).toBe(
      skuLockSuffix(7, { goodsid: '123', shangpin_sku: '', sku_name: 'ab' }),
    );
    // 批量锁键：gid 去重升序（顺序无关）
    expect(batchProcessLockKey(7, [3, 1, 3, 2])).toBe(batchProcessLockKey(7, [1, 2, 3]));
  });
});
