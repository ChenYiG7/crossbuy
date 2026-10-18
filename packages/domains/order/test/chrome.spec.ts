import { describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import {
  CHROME_ACTION,
  CHROME_TRADE_TYPE,
  ChromeService,
  buildProductItemsFromMainOrders,
  buildProductItemsFromSubOrders,
  chromeContextOf,
  chromeSkuName,
  decodeOrderDetail,
  normalizeSkuValue,
  parseChromeSkuPairs,
  parsePostFeeValue,
  removeTags,
  searchSkuDetail,
  type ChromeAdminIdentity,
  type ChromeWebhookInput,
  type PlatformProductItem,
} from '../src/chrome';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

const ADMIN: ChromeAdminIdentity = { id: 7, username: 'buyer01', name: '采购一', payid: 'P-01' };

/** 订单行（chrome 回传链路最小形态；raw INSERT——dump 缺列 S21 同款） */
async function seedOrder(
  tx: Tx,
  input: {
    tid?: string;
    state: number;
    goodsid?: string;
    goodsname?: string;
    skuName?: string;
    goodssize?: string | null;
    goodscolor?: string | null;
    goodsnum?: number;
    goodsprice?: number;
    goodssite?: string;
    goodsseller?: string | null;
    payid?: string | null;
  },
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // 41 个基础列（shipment.spec 同款）+ goodsid/goodsname/goodsseller/payid/sku_name/goodssize/goodscolor
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_order (uid, uname, memberid, tid, goodssite, type, state, goodsid, goodsname, goodsseller, payid,
       goodsprice, goodsprice1, goodsnum, bargainprice, sendprice, inspection, goodsurl, sku_name, goodssize, goodscolor,
       extend, addtime, uptime, expressno, waytime,
       yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU,
       shangpin_sku, FNSKU, shangpin_fnsku, name, shangpin_name, amazon, putong, shangpin_amazon, fuzhuang, tiebiao,
       huanbaoz, qita)
     VALUES (1, 'chromeuser', '', ?, ?, 1, ?, ?, ?, ?, ?,
       ?, 0, ?, 0, 0, 0, 'https://e.com/1', ?, ?, ?,
       NULL, ?, ?, '', NULL,
       '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '')`,
    input.tid ?? '',
    input.goodssite ?? '1688',
    input.state,
    input.goodsid ?? '1001',
    input.goodsname ?? '测试商品',
    input.goodsseller ?? '店铺A',
    input.payid ?? '',
    input.goodsprice ?? 10,
    input.goodsnum ?? 1,
    input.skuName ?? '',
    input.goodssize ?? null,
    input.goodscolor ?? null,
    now,
    now,
  );
  const row = await tx.$queryRawUnsafe<Array<{ oid: number }>>(
    'SELECT oid FROM dg_order WHERE uname = ? AND state = ? ORDER BY oid DESC LIMIT 1',
    'chromeuser',
    input.state,
  );
  return Number(row[0]!.oid);
}

function makeService(
  tx: Tx,
  platform: { baseInfo: Record<string, unknown>; productItems: PlatformProductItem[] } | null,
  admin: ChromeAdminIdentity = ADMIN,
): ChromeService {
  void admin;
  return new ChromeService({
    repository: new OrderRepository(tx as never),
    alibaba: { getOrderDetail: async () => platform },
    runTx: (fn) => fn(tx as never),
    now: () => new Date('2026-10-18T14:00:00+08:00'),
  });
}

function inputOf(over: Partial<ChromeWebhookInput>): ChromeWebhookInput {
  return {
    oids: '0',
    tradeId: 'T-chrome-1',
    action: CHROME_ACTION.VALIDATE,
    tradeType: CHROME_TRADE_TYPE.ALIBABA,
    orderDetail: null,
    skipPriceCheck: false,
    ...over,
  };
}

const SKU_RED = '<font color=red>颜色分类:</font><font color=green>红色</font>';

/** 1688 平台详情：一件 3 个、单价 10、运费 10、红包 4（totalAmount 会加回 couponFee） */
const PLATFORM_1688 = {
  baseInfo: { shippingFee: 10, totalAmount: 30, couponFee: 4 },
  productItems: [
    {
      productID: '1001',
      specId: 'spec-1',
      name: '测试商品',
      quantity: 3,
      price: 10,
      itemAmount: 30,
      skuInfos: [{ name: '颜色分类:', value: '红色' }],
    },
  ],
};

describe('chrome 回传纯函数（旧 sku 解析 / 文本归一化 1:1）', () => {
  it('chromeSkuName：sku_name 为空时用尺码/颜色拼 HTML（尺码在前，冒号是全角）', () => {
    expect(chromeSkuName({ sku_name: SKU_RED, goodssize: null, goodscolor: null })).toBe(SKU_RED);
    expect(chromeSkuName({ sku_name: '', goodssize: 'L', goodscolor: '黑' })).toBe(
      '<font color=red>尺码:</font><font color=green>L</font><font color=red>颜色:</font><font color=green>黑</font>',
    );
  });

  it('parseChromeSkuPairs：名字**保留冒号**（与 list-helpers.parseSkuName 不同），无匹配为 null', () => {
    expect(parseChromeSkuPairs(SKU_RED)).toEqual({ '颜色分类:': '红色' });
    expect(parseChromeSkuPairs('<font color=red>尺码:</font><font color=green>L</font><font color=red>颜色:</font><font color=green>黑</font>')).toEqual({
      '尺码:': 'L',
      '颜色:': '黑',
    });
    expect(parseChromeSkuPairs('')).toBeNull();
    expect(parseChromeSkuPairs('无标签纯文本')).toBeNull();
  });

  it('removeTags 顺序敏感：&nbsp; 先变空格、; 先被删、引号变 &quot;', () => {
    expect(removeTags('a&nbsp;b')).toBe('a b');
    // `&nbsp;` → ' '（不是被删）；`;` 全删
    expect(removeTags('x;y')).toBe('xy');
    // 引号在第 4 步就被删掉 ⇒ 后面那句 `str_replace('"','&quot;')` 是死代码（旧系统同样）
    expect(removeTags('"q"')).toBe('q');
    expect(removeTags('(a){b}')).toBe('ab');
  });

  it('normalizeSkuValue：去非字母/汉字/数字 + 去空格/&nbsp;/NBSP', () => {
    expect(normalizeSkuValue(' 红色 (XL) ')).toBe('红色XL');
    expect(normalizeSkuValue('a&nbsp;b')).toBe('ab');
    expect(normalizeSkuValue('A\u00a0B')).toBe('AB');
  });

  it('searchSkuDetail：精确匹配 / 宽松匹配 / 实体解码匹配（含「带空格值只认 + 形态」怪癖）', () => {
    const items: PlatformProductItem[] = [
      {
        productID: '1001',
        specId: 's1',
        name: 'n',
        quantity: 1,
        price: 10,
        itemAmount: 10,
        // 平台规格名通常不带冒号，而订单 sku_name 解析出的名字带冒号 ⇒ 靠 trim(':') 对齐
        skuInfos: [{ name: '颜色分类', value: '红色 (XL)' }],
      },
    ];
    // 精确：name（去冒号后）+ value 都一致
    expect(searchSkuDetail('1001', items, { '颜色分类:': '红色 (XL)' }, 1).ok).toBe(true);
    // 精确失败 → 宽松（去符号/空格）命中
    expect(searchSkuDetail('1001', items, { '颜色分类:': '红色(XL)' }, 1).ok).toBe(false);
    expect(searchSkuDetail('1001', items, { '颜色分类:': '红色(XL)' }, 2).ok).toBe(true);
    // type 3：value 先解码实体再宽松比对；⚠ name 不归一化（旧代码只动 value）
    expect(searchSkuDetail('1001', items, { '颜色分类:': '红色XL' }, 3).ok).toBe(true);
    // ⚠ 值里带空白时只试「空格换 +」形态，name+value 与 value-only 都用 '+' 比对（S51）：
    //    name 对不上 ⇒ 精确匹配失败，宽松匹配才命中
    expect(searchSkuDetail('1001', items, { '颜色': '红色 (XL)' }, 1).ok).toBe(false);
    expect(searchSkuDetail('1001', items, { '颜色': '红色 (XL)' }, 2).ok).toBe(true);
  });

  it('searchSkuDetail 五种失败形态（文案 1:1）', () => {
    const items: PlatformProductItem[] = [
      { productID: '1001', skuInfos: [{ name: '颜色:', value: '红' }], quantity: 1, price: 1, itemAmount: 1 },
      { productID: '1001', skuInfos: [{ name: '颜色:', value: '蓝' }], quantity: 1, price: 1, itemAmount: 1 },
      { productID: '2002', skuInfos: [], quantity: 1, price: 1, itemAmount: 1 },
      { productID: '3003', skuInfos: [{ name: '颜色:', value: '红' }, { name: '尺码:', value: 'L' }], quantity: 1, price: 1, itemAmount: 1 },
      { productID: '4004', quantity: 1, price: 1, itemAmount: 1 },
    ];
    expect(searchSkuDetail('9999', items, { '颜色:': '红' }).ok).toBe(false);
    expect(searchSkuDetail('1001', items, {})).toEqual({ ok: false, msg: 'sku 信息为空，请联系管理员处理。' });
    // 无 skuInfos → 直接报「无法识别」
    const noSku = searchSkuDetail('4004', items, { '颜色:': '红' });
    expect(noSku.ok).toBe(false);
    expect(noSku.ok === false && noSku.msg).toContain('无法识别以下 sku 信息');
    // 规格数量不一致
    const mismatch = searchSkuDetail('3003', items, { '颜色:': '红' });
    expect(mismatch.ok === false && mismatch.msg).toContain('用户下单的 sku 数量和官方返回的不一致');
    // 值都不对 → 缺少规格
    const missing = searchSkuDetail('1001', items, { '颜色:': '绿' });
    expect(missing.ok === false && missing.msg).toContain('下单信息中缺少以下规格商品');
    // 同一个期望值命中多行 dup —— 用两个同规格行构造
    const dupItems: PlatformProductItem[] = [
      { productID: '5005', skuInfos: [{ name: '颜色:', value: '红' }], quantity: 1, price: 1, itemAmount: 1, specId: 'a' },
      { productID: '5005', skuInfos: [{ name: '颜色:', value: '红' }], quantity: 1, price: 1, itemAmount: 1, specId: 'b' },
    ];
    const dup = searchSkuDetail('5005', dupItems, { '颜色:': '红' });
    expect(dup.ok === false && dup.msg).toContain('下单信息中存在重复规格的商品');
  });

  it('buildProductItemsFromSubOrders：标题洗成 productID、specId=md5(sku_infos)、价格恒 0', () => {
    const items = buildProductItemsFromSubOrders([
      { name: '商品#1 (红)', quantity: 2, sku_infos: [{ name: '颜色', value: '红' }] },
      { name: '无规格', quantity: 1 },
    ]);
    expect(items[0]).toMatchObject({ productID: '商品1红', price: 0, itemAmount: 0, quantity: 2 });
    expect(items[0]!.specId).toMatch(/^[0-9a-f]{32}$/);
    expect(items[1]!.specId).toBeUndefined();
  });

  it('buildProductItemsFromMainOrders：赠品（无 id）跳过、skuId=-1 无 specId、itemAmount=单价×数量', () => {
    const items = buildProductItemsFromMainOrders([
      { id: '', quantity: 1, itemInfo: { title: '赠品' } },
      {
        id: 'sub-1',
        quantity: 2,
        itemInfo: { title: '主商品', id: '9001', skuId: 456, skuText: [{ name: '尺寸', value: 'M' }] },
        priceInfo: { realTotal: 12.345 },
      },
      { id: 'sub-2', quantity: 1, itemInfo: { title: '无型号', id: '9002', skuId: -1 }, priceInfo: { realTotal: 5 } },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ productID: '9001', specId: '456', quantity: 2, price: 12.345, itemAmount: 24.69 });
    expect(items[1]!.specId).toBeUndefined();
  });

  it('parsePostFeeValue：只认 `￥12.30` 形态，其余一律 0（不是 null）', () => {
    expect(parsePostFeeValue('￥12.30')).toBe(12.3);
    expect(parsePostFeeValue('￥0')).toBe(0);
    expect(parsePostFeeValue('12.30')).toBe(0);
    expect(parsePostFeeValue('¥12.30')).toBe(0);
    expect(parsePostFeeValue(undefined)).toBe(0);
  });

  it('decodeOrderDetail：JSON 串解析失败 → null（旧 `is_string ? json_decode : 原样`）', () => {
    expect(decodeOrderDetail('{"a":1}')).toEqual({ a: 1 });
    expect(decodeOrderDetail('not-json')).toBeNull();
    expect(decodeOrderDetail({ b: 2 })).toEqual({ b: 2 });
    expect(decodeOrderDetail(undefined)).toBeNull();
  });
});

describe('chrome 回传校验（validateOrderByOidAndTradeId 1:1）', () => {
  it('1688：红包加回实付 + 同商品跨单合并数量 + 砍价 = 商品合计 + 平台运费 − 实付', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 2 });
      const b = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 1 });
      const svc = makeService(tx, PLATFORM_1688);

      const result = await svc.handle(inputOf({ oids: `${a},${b}`, tradeId: 'T-1', action: CHROME_ACTION.VALIDATE }), ADMIN);
      expect(result.code).toBe(200);
      const data = result.code === 200 ? result.data! : null;
      expect(data).toMatchObject({
        trade_parent_id: 'T-1',
        post_fee: '10',
        // 30 + 红包 4 = 34（红包加回总价 ⇒ 砍价只算真实让价 6）
        real_pay: '34',
        bargainprice: '6',
        coupon_fee: '4',
      });
      expect(data!.items).toHaveLength(1);
      expect(data!.items[0]).toMatchObject({ offerId: '1001', specId: 'spec-1', quantity: 3, price: 10, real_price: 10 });
      expect(data!.items[0]!.ids.sort()).toEqual([a, b].sort());
    });
  });

  it('1688：SDK 拿不到详情 → 40000「获取订单信息失败」（旧 !isSuccess 原样返回）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 1 });
      const svc = makeService(tx, null);
      expect(await svc.handle(inputOf({ oids: String(a) }), ADMIN)).toEqual({ code: 40000, msg: '获取订单信息失败。' });
    });
  });

  it('订单不存在 → 40000 且回带 oids 原串（旧 `"oids" => $oids`）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const svc = makeService(tx, PLATFORM_1688);
      const result = await svc.handle(inputOf({ oids: '9999991,9999992' }), ADMIN);
      expect(result).toEqual({ code: 40000, oids: ['9999991', '9999992'], msg: '获取订单信息失败。' });
    });
  });

  it('数量不一致 / 实际单价大于后台单价 → 两道守卫；skip_price_check 可整体旁路', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 2 });

      // 数量：后台 2 vs 平台 3
      const svcQty = makeService(tx, PLATFORM_1688);
      const qty = await svcQty.handle(inputOf({ oids: String(a) }), ADMIN);
      expect(qty.code === 40000 && qty.msg).toContain('实际下单的商品数量与后台中期望值不一致');

      // 单价：后台 10 vs 平台 12（数量对齐）
      const svcPrice = makeService(tx, {
        baseInfo: { shippingFee: 10, totalAmount: 36, couponFee: 0 },
        productItems: [{ ...PLATFORM_1688.productItems[0]!, price: 12, itemAmount: 36 }],
      });
      const price = await svcPrice.handle(inputOf({ oids: String(a) }), ADMIN);
      expect(price.code === 40000 && price.msg).toContain('商品实际单价大于后台单价');

      // 后门旁路（旧 skip_price_check）
      const bypass = await svcPrice.handle(inputOf({ oids: String(a), skipPriceCheck: true }), ADMIN);
      expect(bypass.code).toBe(200);
    });
  });

  it('负砍价（实付高于本地基线）→ 风控阻断（文案含五段金额）', async () => {
    await rollbackRun(async (tx) => {
      const a = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 3 });
      const risk: Record<string, unknown>[] = [];
      const svc = new ChromeService({
        repository: new OrderRepository(tx as never),
        alibaba: {
          getOrderDetail: async () => ({
            baseInfo: { shippingFee: 10, totalAmount: 999, couponFee: 0 },
            productItems: PLATFORM_1688.productItems,
          }),
        },
        riskLog: (info) => risk.push(info),
        runTx: (fn) => fn(tx as never),
        now: () => new Date('2026-10-18T14:00:00+08:00'),
      });
      const result = await svc.handle(inputOf({ oids: String(a) }), ADMIN);
      expect(result.code).toBe(40000);
      expect(result.code === 40000 && result.msg).toContain('实际付款不能大于当前本地价格基线，已阻断自动改价。');
      expect(risk).toHaveLength(1);
      expect(risk[0]).toMatchObject({ localGoodsTotal: 30, platformSendprice: 10, platformRealPay: 999, localBaselineTotal: 40 });
    });
  });
});

describe('chrome 回传保存（saveOrderInfo + BatchUpdateOrder 子集）', () => {
  it('SAVE：tid/payid/paytime/purchase_type 落库 + 运费砍价落承载单 + 红包行 + 砍价记录', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 2 });
      const b = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 1 });
      const svc = makeService(tx, PLATFORM_1688);

      const result = await svc.handle(
        inputOf({
          oids: `${a},${b}`,
          tradeId: 'T-save-1',
          action: CHROME_ACTION.SAVE,
          orderDetail: { action: CHROME_ACTION.SAVE, seller: '店铺A' },
        }),
        ADMIN,
      );
      expect(result).toEqual({ code: 200 });

      const rows = await tx.dg_order.findMany({
        where: { oid: { in: [a, b] } },
        select: { oid: true, tid: true, payid: true, paytime: true, purchase_type: true, sendprice: true, bargainprice: true },
      });
      for (const row of rows) {
        expect(row.tid).toBe('T-save-1');
        expect(row.payid).toBe('P-01');
        expect(row.paytime).toBe(Math.floor(new Date('2026-10-18T14:00:00+08:00').getTime() / 1000));
        expect(row.purchase_type).toBe(1); // 手动下单
      }
      // 运费/砍价只挂在**一张**承载单上，另一张归零
      const withSend = rows.filter((r) => Number(r.sendprice) !== 0);
      expect(withSend).toHaveLength(1);
      expect(Number(withSend[0]!.sendprice)).toBe(10);
      expect(Number(withSend[0]!.bargainprice)).toBe(6);

      // 红包落 v2_order_detail（id = 承载单 oid）
      const detail = await tx.v2_order_detail.findUnique({ where: { id: withSend[0]!.oid } });
      expect(Number(detail?.coupon_fee)).toBe(4);

      // 砍价记录：唯一键 (goodid, goodstype) ⇒ 同商品两单只留一行（旧 updateOrCreate 语义）
      const bargains = await tx.dg_bargain_record.findMany({ where: { goodid: BigInt(1001), goodstype: 1 } });
      expect(bargains).toHaveLength(1);
      expect(bargains[0]).toMatchObject({ adminid: 7, adminname: 'buyer01' });
    });
  });

  it('SAVE：店铺名不一致 → 40000（旧 validate_seller_name 文案）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 3 });
      const svc = makeService(tx, PLATFORM_1688);
      const result = await svc.handle(
        inputOf({
          oids: String(a),
          action: CHROME_ACTION.SAVE,
          orderDetail: { action: CHROME_ACTION.SAVE, seller: '别的店' },
        }),
        ADMIN,
      );
      expect(result.code).toBe(40000);
      expect(result.code === 40000 && result.msg).toContain('获取卖家昵称失败');
      expect(result.code === 40000 && result.msg).toContain('后台昵称：店铺A，当前昵称：别的店');
    });
  });

  it('SAVE：账号未绑定采购员 → 40000（且不落任何字段）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 1, skuName: SKU_RED, goodsnum: 3 });
      const svc = makeService(tx, PLATFORM_1688);
      const result = await svc.handle(
        inputOf({ oids: String(a), tradeId: 'T-nopay', action: CHROME_ACTION.SAVE, orderDetail: { action: CHROME_ACTION.SAVE } }),
        { ...ADMIN, payid: '' },
      );
      expect(result).toEqual({ code: 40000, msg: '当前账号未绑定采购员，暂不允许更新单号。请联系管理员处理。' });
      const row = await tx.dg_order.findUnique({ where: { oid: a }, select: { tid: true, sendprice: true } });
      expect(row?.tid).toBe('');
      expect(Number(row?.sendprice)).toBe(0);
    });
  });

  it('SAVE：非待采购状态 → 40000「有订单处未处于待采购状态」', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      const a = await seedOrder(tx, { state: 2, skuName: SKU_RED, goodsnum: 3 });
      const svc = makeService(tx, PLATFORM_1688);
      const result = await svc.handle(
        inputOf({ oids: String(a), action: CHROME_ACTION.SAVE, orderDetail: { action: CHROME_ACTION.SAVE } }),
        ADMIN,
      );
      expect(result).toEqual({ code: 40000, msg: '有订单处未处于待采购状态，暂不支持更新。' });
    });
  });

  it('单行回传：金额承载单从别单迁到被编辑单（改金额不会改错行）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as unknown as Tx;
      // 同 tid 两单，运费+砍价挂在较新的 a 上
      const a = await seedOrder(tx, { tid: 'T-group', state: 1, skuName: SKU_RED, goodsnum: 2 });
      const b = await seedOrder(tx, { tid: 'T-group', state: 1, skuName: SKU_RED, goodsnum: 1 });
      await tx.dg_order.updateMany({ where: { oid: a }, data: { sendprice: 12, bargainprice: 8 } });

      const svc = new ChromeService({
        repository: new OrderRepository(tx as never),
        alibaba: {
          getOrderDetail: async () => ({
            baseInfo: { shippingFee: 10, totalAmount: 20, couponFee: 0 },
            productItems: [{ ...PLATFORM_1688.productItems[0]!, quantity: 1, itemAmount: 10 }],
          }),
        },
        runTx: (fn) => fn(tx as never),
        now: () => new Date('2026-10-18T14:00:00+08:00'),
      });

      // 只回传较旧的 b（后台数量改成 1 以对齐平台数量 1）
      await tx.dg_order.updateMany({ where: { oid: b }, data: { goodsnum: 1 } });
      const result = await svc.handle(
        inputOf({ oids: String(b), tradeId: 'T-group', action: CHROME_ACTION.SAVE, orderDetail: { action: CHROME_ACTION.SAVE } }),
        ADMIN,
      );
      expect(result).toEqual({ code: 200 });

      const rowB = await tx.dg_order.findUnique({ where: { oid: b }, select: { sendprice: true, bargainprice: true } });
      // 承载金额迁到 b，a 清零
      expect(Number(rowB?.sendprice)).toBe(10);
      const rowA = await tx.dg_order.findUnique({ where: { oid: a }, select: { sendprice: true, bargainprice: true } });
      expect(Number(rowA?.sendprice)).toBe(0);
      expect(Number(rowA?.bargainprice)).toBe(0);
    });
  });
});

/** 需要自定义 deps 的用例：复用 rollback 事务（与 withRollback 同语义） */
async function rollbackRun(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await withRollback(async (tx0) => fn(tx0 as unknown as Tx));
}

void legacyPrisma;
