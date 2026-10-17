import { afterAll, describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import {
  AddCartService,
  buildRepurchaseItems,
  compareExtraFields,
  findBelowMinOrderQuantity,
  formatSkuNameHtml,
  generateSkuAttrsHash,
  mixRule,
  normalizeAttrPairs,
  parsePriceRangeJson,
  parseSkuAttrsFromCart,
  propsFromPlatformSku,
  resolveMinOrderQuantity,
  resolvePlatformImage,
  resolvePlatformSku,
  shopKey,
  shopKeysMeetingMix,
  type AddCartDeps,
  type AlibabaShopPort,
  type FrontendUrlPort,
  type GoodsUrlParserPort,
  type PlatformGoodsInfo,
  type PlatformGoodsInfoPort,
} from '../src/add-cart';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

/**
 * 加购链路（旧 AddCartMutation 1:1）测试。
 *
 * 分两组：① 纯函数（无 IO，直锁语义）；② 服务（真实 MySQL + withRollback，dump 不被写脏）。
 * 端口一律给**可控桩**——平台 SDK / 队列在 R1 恒空，行为可断言。
 */

// 基址随机高位：dump 是旧库尾切片，低位 id 撞存量行
let nextGid = 98_700_000 + Math.floor(Math.random() * 100_000);

const CART_EMPTY_COLS =
  'yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU, FNSKU, name, amazon, putong, fuzhuang, tiebiao, huanbaoz, qita, var1, var2, var3, var4, var5, var6, var7';

// ---------------------------------------------------------------------------
// ① 纯函数
// ---------------------------------------------------------------------------

describe('加购纯函数（旧 AddCartMutation 私有方法 1:1）', () => {
  it('formatSkuNameHtml：含冒号与空格位置的 HTML 串', () => {
    expect(formatSkuNameHtml([{ name: '色', value: '赤' }])).toBe(
      '<font color=red>色:</font><font color=green> 赤 </font>',
    );
    expect(formatSkuNameHtml([])).toBe('');
  });

  it('generateSkuAttrsHash：与属性顺序无关（sortAttrs 按 name 排序）', () => {
    const a = generateSkuAttrsHash([{ name: 'サイズ', value: 'M' }, { name: '色', value: '赤' }]);
    const b = generateSkuAttrsHash([{ name: '色', value: '赤' }, { name: 'サイズ', value: 'M' }]);
    expect(a).toBe(b);
    expect(generateSkuAttrsHash([])).toBe(generateSkuAttrsHash([]));
  });

  it('parseSkuAttrsFromCart：sku_name HTML 往返 + 空值回退 []', () => {
    const html = formatSkuNameHtml([{ name: '色', value: '赤' }]);
    expect(parseSkuAttrsFromCart(html)).toEqual([{ name: '色', value: '赤' }]);
    expect(parseSkuAttrsFromCart('')).toEqual([]);
    expect(parseSkuAttrsFromCart(null)).toEqual([]);
  });

  it('compareExtraFields：null/空串等价，"0" 按 empty 处理，差异即不合', () => {
    const base = { goodsremark: '', outid: null, var1: ' ', yanhuofba: 'FBA' };
    expect(compareExtraFields(base, { goodsremark: '', outid: '', var1: ' ', yanhuofba: 'FBA' })).toBe(true);
    expect(compareExtraFields({ outid: '0' }, { outid: '' })).toBe(true);
    expect(compareExtraFields({ var1: 'Y' }, { var1: 'N' })).toBe(false);
  });

  it('normalizeAttrPairs：大小写折叠 + 排序（SKU 匹配用）', () => {
    expect(normalizeAttrPairs([{ name: ' Color ', value: ' RED' }])).toEqual(['color:red']);
  });

  it('resolvePlatformSku：skuId 优先 → props 全等 → 单 SKU 回落 → 无匹配 null', () => {
    const goods: PlatformGoodsInfo = {
      title: 't',
      skus: [
        { skuId: 's1', properties: '1:2', price: 10 },
        { skuId: 's2', properties: '3:4', price: 20 },
      ],
      propsList: { '1:2': '色:赤', '3:4': 'サイズ:M' },
    };
    expect(resolvePlatformSku(goods, { shangpin_sku: 's2' })?.skuId).toBe('s2');
    expect(
      resolvePlatformSku(goods, { shangpin_sku: '' }, [{ name: 'サイズ', value: 'M' }])?.skuId,
    ).toBe('s2');
    expect(resolvePlatformSku({ title: 't', skus: [{ skuId: 'only' }] }, { shangpin_sku: 'zzz' })?.skuId).toBe('only');
    expect(resolvePlatformSku(goods, { shangpin_sku: 'nope' }, [{ name: 'x', value: 'y' }])).toBeNull();
    expect(resolvePlatformSku({ title: 't', skus: [] }, { shangpin_sku: 's1' })).toBeNull();
  });

  it('propsFromPlatformSku：skuAttributes 优先，否则按 properties 查 props_list', () => {
    expect(propsFromPlatformSku({ skuAttributes: [{ attributeName: '色', value: ' 赤 ' }] }, {})).toEqual([
      { name: '色', value: '赤' },
    ]);
    expect(propsFromPlatformSku({ properties: '1:2' }, { '1:2': '色: 赤' })).toEqual([{ name: '色', value: '赤' }]);
    expect(propsFromPlatformSku({ properties: '1:2' }, {})).toEqual([]);
  });

  it('resolvePlatformImage：props_img 命中优先，否则首张 item_imgs', () => {
    expect(
      resolvePlatformImage({ title: 't', propsImg: { '1:2': 'http://img/a' }, itemImgs: ['http://img/b'] }, { properties: '1:2' }),
    ).toBe('http://img/a');
    expect(resolvePlatformImage({ title: 't', itemImgs: [{ url: 'http://img/c' }] }, {})).toBe('http://img/c');
    expect(resolvePlatformImage({ title: 't' }, {})).toBe('');
  });

  it('mixRule：平台优先 / 回落请求 JSON / 全 0 视为无规则', () => {
    const goodsInfo = { platform: '1688', title: 't', quantity: 1 } as never;
    expect(mixRule({ title: 't', sellerMixSetting: { mixAmount: 800, mixNumber: 0 } }, goodsInfo)).toEqual({
      mixAmount: 800,
      mixNumber: 0,
    });
    expect(mixRule(null, { ...goodsInfo, sellerMixSetting: '{"mixNumber":5}' } as never)).toEqual({
      mixAmount: 0,
      mixNumber: 5,
    });
    expect(mixRule(null, { ...goodsInfo, sellerMixSetting: 'not-json' } as never)).toBeNull();
    expect(mixRule({ title: 't', sellerMixSetting: { mixAmount: 0, mixNumber: 0 } }, goodsInfo)).toBeNull();
  });

  it('resolveMinOrderQuantity：平台 0/缺失 → 1（不是 0，旧代码原话）', () => {
    const goodsInfo = { platform: '1688', title: 't', quantity: 1 } as never;
    expect(resolveMinOrderQuantity({ title: 't', minNum: 5 }, goodsInfo)).toBe(5);
    expect(resolveMinOrderQuantity({ title: 't', minNum: 0 }, goodsInfo)).toBe(1);
    expect(resolveMinOrderQuantity(null, { ...goodsInfo, minOrderQuantity: 3 } as never)).toBe(3);
    expect(resolveMinOrderQuantity(null, goodsInfo)).toBe(0);
  });

  it('shopKey：有卖家标识走 shop，否则退化 goods', () => {
    expect(shopKey({ title: 't', sellerInfo: { openid: 'o1' } }, '1688', 'g1')).toBe('1688:shop:o1');
    expect(shopKey(null, '1688', 'g1')).toBe('1688:goods:g1');
  });

  it('findBelowMinOrderQuantity：混批达标放行 / 否则拦截首个违规行', () => {
    const line = (over: Partial<Parameters<typeof findBelowMinOrderQuantity>[0][number]>) => ({
      key: 'k', title: 'T', quantity: 2, amount: 200, min: 5, shopKey: 's', hasMix: false, mix: null,
      ...over,
    });
    expect(findBelowMinOrderQuantity([line({ quantity: 9 })])).toBeNull();
    expect(findBelowMinOrderQuantity([line({})])?.quantity).toBe(2);
    // 店铺混批达标（金额 800）→ 放行
    expect(
      findBelowMinOrderQuantity([
        line({ quantity: 2, amount: 500, hasMix: true, mix: { mixAmount: 800, mixNumber: 0 } }),
        line({ quantity: 2, amount: 400, hasMix: true, mix: { mixAmount: 800, mixNumber: 0 } }),
      ]),
    ).toBeNull();
    expect(shopKeysMeetingMix([line({ hasMix: true, mix: { mixAmount: 800, mixNumber: 0 } })])).toEqual({});
  });

  it('parsePriceRangeJson：缺 price/startQuantity 任一键 → null', () => {
    expect(parsePriceRangeJson('[{"price":"6.5","startQuantity":3}]')).toHaveLength(1);
    expect(parsePriceRangeJson('[{"price":"6.5"}]')).toBeNull();
    expect(parsePriceRangeJson('[]')).toBeNull();
    expect(parsePriceRangeJson('oops')).toBeNull();
    expect(parsePriceRangeJson(undefined)).toBeNull();
  });

  it('buildRepurchaseItems：只带非空值，数组原样标量转串', () => {
    const items = buildRepurchaseItems(['s1'], [3], [{ var1: 'Y', outid: null, props: [{ name: 'a', value: 'b' }] }]);
    expect(items).toEqual([{ skuId: 's1', quantity: 3, var1: 'Y', props: [{ name: 'a', value: 'b' }] }]);
  });
});

// ---------------------------------------------------------------------------
// ② 服务（真实 MySQL，事务回滚）
// ---------------------------------------------------------------------------

/** 测试用 dg_users */
async function seedUser(tx: Tx, dfflag = 0) {
  const uname = `addcart_${Math.random().toString(36).slice(2, 8)}`;
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_users (uname, password, card, memberid, email, money, dfflag, utype, validity, dffee, state)
     VALUES (?, 'x', 'test', ?, NULL, 100, ?, 0, 0, 10, 1)`,
    uname, uname, dfflag,
  );
  const row = await tx.dg_users.findFirst({ where: { uname }, select: { uid: true, uname: true } });
  expect(row).toBeTruthy();
  return { uid: Number(row!.uid), uname: row!.uname };
}

/** 已存在的购物车行（合并用例的重复对象；需补齐 24 个无默认串列） */
async function seedCart(tx: Tx, input: Record<string, unknown>) {
  const gid = nextGid++;
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_cart (gid, uid, uname, supplier_product_id, type, goodsurl, goodsname, goodsprice,
       offer_price, one_piece_price, sendprice, goodsnum, min_order_quantity, goodsseller, goodssite,
       goodsid, sku_name, goodsremark, addtime, add_from, ${CART_EMPTY_COLS})
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, ?, ?, ?, ?, ?, 0,
       ${CART_EMPTY_COLS.split(',').map(() => `''`).join(',')})`,
    gid, input.uid, input.uname ?? '', input.type ?? 1, input.goodsurl ?? 'https://e.com/p?id=1001',
    input.goodsname ?? 'テスト商品', input.goodsprice ?? 100, input.goodsnum ?? 2,
    input.goodsseller ?? 'shopA', input.goodssite ?? '淘宝', input.goodsid ?? '1001',
    input.sku_name ?? '', input.goodsremark ?? '', Math.floor(Date.now() / 1000),
  );
  return gid;
}

interface StubOpts {
  dfflag?: number;
  cartMaxCount?: number;
  platformGoods?: PlatformGoodsInfo | null;
  supplierProductId?: number;
  url?: string;
}

function makeDeps(tx: Tx, opts: StubOpts = {}) {
  const calls = {
    syncProduct: [] as number[],
    subscribeProduct: [] as number[],
    completionGoods: [] as number[],
    translateGoods: [] as number[],
    resolveProduct: 0,
  };
  const urlParser: GoodsUrlParserPort = {
    async parse(u) {
      const id = /[?&]id=(\d+)/.exec(u)?.[1] ?? /offer\/(\d+)\.html/.exec(u)?.[1] ?? '';
      return id === '' ? [] : [{ detail: { itemId: id, miId: 'mi-1' } }];
    },
  };
  const platformGoods: PlatformGoodsInfoPort = { fetch: async () => opts.platformGoods ?? null };
  const alibabaShop: AlibabaShopPort = {
    searchShopNameByGoodsId: async () => null,
    decryptOpenidFromFenxiaoApi: async () => null,
  };
  const frontendUrl: FrontendUrlPort = { build: (path) => `https://www.yiwutaro.com/${path}` };

  const deps: AddCartDeps = {
    repository: new OrderRepository(tx as never),
    memberPort: {
      getMoneyFactors: async () => ({
        isDf: (opts.dfflag ?? 0) === 1,
        dffee: 10,
        utype: 0,
        uname: 'cart-uname',
      }),
    },
    urlParser,
    platformGoods,
    alibabaShop,
    supplierProduct: {
      resolveOrCreate: async () => {
        calls.resolveProduct += 1;
        return opts.supplierProductId === undefined ? null : { id: opts.supplierProductId };
      },
    },
    supplierShop: {
      findByOpenId: async () => null,
      create: async () => ({ id: 1, title: 't', nickname: null }),
      update: async (id, patch) => ({ id, title: patch.title ?? null, nickname: patch.nickname ?? null }),
    },
    sideEffects: {
      enqueueSyncSupplierProduct: async (id) => void calls.syncProduct.push(id),
      enqueueSubscribeSupplierProduct: async (id) => void calls.subscribeProduct.push(id),
      enqueueCompletionGoodsInfoForCart: async (gid) => void calls.completionGoods.push(gid),
      enqueueTranslateCartGoodsInfo: async (gid) => void calls.translateGoods.push(gid),
    },
    frontendUrl,
    alibabaFenxiaoAppid: 1,
    cartMaxCount: opts.cartMaxCount ?? 10000,
  };
  return { deps, calls };
}

const member = (uid: number) => ({ kind: 'member' as const, subject: String(uid) });

describe('AddCartService（旧 batchAddCart 1:1；真实 MySQL + 回滚）', () => {
  afterAll(async () => {
    await legacyPrisma.$disconnect();
  });

  it('基本加购：落库列 1:1 + result=done + 翻译 Job 投递', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps, calls } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [
          {
            platform: 'taobao',
            url: 'https://item.taobao.com/item.htm?id=1001',
            title: 'テスト商品',
            shopNick: 'shopA',
            price: 88.5,
            quantity: 3,
            props: [{ name: '色', value: '赤' }, { name: '', value: 'x' }, { name: 'y', value: null }],
            addFrom: 1,
          },
        ],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.result).toBe('done');

      const rows = await (tx as unknown as { dg_cart: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> } }).dg_cart.findMany({
        where: { uid: user.uid },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row['uid']).toBe(user.uid);
      expect(row['uname']).toBe('cart-uname');
      expect(row['type']).toBe(1); // 代购
      expect(row['goodssite']).toBe('淘宝');
      expect(row['goodsid']).toBe('1001');
      expect(Number(row['goodsprice'])).toBe(88.5);
      expect(row['goodsnum']).toBe(3);
      expect(row['goodsremark']).toBe('');
      expect(row['add_from']).toBe(1);
      // sku_name：只有合法 props 参与（空名/空值整条跳过）
      expect(row['sku_name']).toBe('<font color=red>色:</font><font color=green> 赤 </font>');
      // 24 个无默认列落 ''（MySQL 非严格模式等价）
      expect(row['yanhuofba']).toBe('');
      // miId 不在 fillable 白名单 → 不落库（dg_cart 本就无此列）
      expect(row['miId']).toBeUndefined();
      // supplier_product_id：未传 productId 且端口给 null → 0
      expect(row['supplier_product_id']).toBe(0);
      // 淘宝有 goodsurl → 翻译 Job 必投
      expect(calls.translateGoods).toHaveLength(1);
      // 缺图或缺店铺名 → 补图 Job（本例 goodsseller='shopA'、goodsimg='' → 投）
      expect(calls.completionGoods).toHaveLength(1);
    });
  });

  it('returnCartId=true → result 为 gid 串；dfflag=1 → type=3', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, 1);
      const { deps } = makeDeps(tx, { dfflag: 1 });

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [{ platform: '1688', url: 'https://detail.1688.com/offer/2002.html', title: 'A', quantity: 1 }],
        returnCartId: true,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.cartIds).toHaveLength(1);
      expect(res.value.result).toBe(String(res.value.cartIds[0]));

      const row = await (tx as unknown as { dg_cart: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).dg_cart.findFirst({
        where: { uid: user.uid },
      });
      expect(row?.['type']).toBe(3); // 代发
      expect(row?.['goodssite']).toBe('1688');
      expect(row?.['siteurl']).toBe('www.1688.com');
    });
  });

  it('转运加购：type=2 / siteurl ### / goodsseller 默认 shipforme / sendprice 入参', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [{ platform: 'transshipment', title: 'B', quantity: 1, sendPrice: 42.5, expressNo: 'EX1' }],
      });
      expect(res.ok).toBe(true);

      const row = await (tx as unknown as { dg_cart: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).dg_cart.findFirst({
        where: { uid: user.uid },
      });
      expect(row?.['type']).toBe(2);
      expect(row?.['siteurl']).toBe('###');
      expect(row?.['goodsseller']).toBe('shipforme'); // 未传 shopNick 的默认值
      expect(Number(row?.['sendprice'])).toBe(42.5);
      expect(row?.['expressno']).toBe('EX1');
    });
  });

  it('isValidate=1 → 预处理前短路，返回空串且不落库', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [{ platform: 'taobao', title: 'A', quantity: 1 }],
        isValidate: 1,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.result).toBe('');
      const count = await (tx as unknown as { dg_cart: { count: (a: unknown) => Promise<number> } }).dg_cart.count({
        where: { uid: user.uid },
      });
      expect(count).toBe(0);
    });
  });

  it('isValidate=2 合并：同 goodsid+sku 且额外字段一致 → 数量合并 + 旧行删除', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const skuName = '<font color=red>色:</font><font color=green> 赤 </font>';
      const oldGid = await seedCart(tx, {
        uid: user.uid,
        uname: 'cart-uname',
        goodsid: '1001',
        goodssite: '淘宝',
        sku_name: skuName,
        goodsnum: 2,
        goodsremark: '',
      });
      const { deps } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [
          {
            platform: 'taobao',
            url: 'https://item.taobao.com/item.htm?id=1001',
            title: 'テスト商品',
            price: 100,
            quantity: 1,
            props: [{ name: '色', value: '赤' }],
          },
        ],
        isValidate: 2,
      });
      expect(res.ok).toBe(true);

      const rows = await (tx as unknown as { dg_cart: { findMany: (a: unknown) => Promise<Array<Record<string, unknown>>> } }).dg_cart.findMany({
        where: { uid: user.uid },
      });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!['gid'])).not.toBe(oldGid);
      expect(rows[0]!['goodsnum']).toBe(3); // 新 1 + 旧 2
    });
  });

  it('行数上限：currentCount + delta > max → CART_MAX_COUNT_REACHED', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      await seedCart(tx, { uid: user.uid, goodsid: '9001' });
      const { deps } = makeDeps(tx, { cartMaxCount: 2 });

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [
          { platform: 'taobao', title: 'A', quantity: 1 },
          { platform: 'taobao', title: 'B', quantity: 1 },
        ],
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('CART_MAX_COUNT_REACHED');
      expect(res.error.message).toBe('购物车数量已达上限（2 个）。');
    });
  });

  it('再买一单（addFrom=6）淘宝商品拉不到 → CART_GOODS_OFF_SHELF', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [{ platform: 'taobao', url: 'https://item.taobao.com/item.htm?id=1001', title: 'A', quantity: 1, addFrom: 6 }],
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('CART_GOODS_OFF_SHELF');
    });
  });

  it('传入 productId → 不解析供应商商品（端口零调用），supplier_product_id 原样落库', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps, calls } = makeDeps(tx, { supplierProductId: 555 });

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [{ platform: '1688', url: 'https://detail.1688.com/offer/2002.html', title: 'A', quantity: 1, productId: 555 }],
        returnCartId: true,
      });
      expect(res.ok).toBe(true);
      expect(calls.resolveProduct).toBe(0);
      // 同商品只投一次队列（旧 productIdsQueue 去重）
      expect(calls.syncProduct).toEqual([555]);
      expect(calls.subscribeProduct).toEqual([555]);

      const row = await (tx as unknown as { dg_cart: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).dg_cart.findFirst({
        where: { uid: user.uid },
      });
      expect(row?.['supplier_product_id']).toBe(555);
    });
  });

  it('平台实价覆盖：goodsprice/one_piece/offer/retail/proprice 被 SKU 实价改写', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps } = makeDeps(tx, {
        platformGoods: {
          title: '平台标题',
          status: 'published',
          skus: [
            {
              skuId: 'sk-1',
              price: '66.666',
              onePiecePrice: 70,
              offerPrice: 60,
              retailPrice: 99.5,
              promotionPrice: '55.5',
              skuAttributes: [{ attributeName: '色', value: '青' }],
            },
          ],
          sellerInfo: { nick: '平台店铺' },
        },
      });

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [
          {
            platform: '1688',
            url: 'https://detail.1688.com/offer/2002.html',
            title: 'A',
            quantity: 1,
            price: 100,
            skuId: 'sk-1',
          },
        ],
        returnCartId: true,
      });
      expect(res.ok).toBe(true);

      const row = await (tx as unknown as { dg_cart: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).dg_cart.findFirst({
        where: { uid: user.uid },
      });
      expect(Number(row?.['goodsprice'])).toBe(66.67); // round2
      expect(Number(row?.['one_piece_price'])).toBe(70);
      expect(Number(row?.['offer_price'])).toBe(60);
      expect(Number(row?.['retail_price'])).toBe(99.5);
      expect(Number(row?.['proprice'])).toBe(55.5);
      // 缺 goodsseller → 平台昵称补全；缺 props → sku_name 由平台 SKU 规格重建
      expect(row?.['goodsseller']).toBe('平台店铺');
      expect(row?.['sku_name']).toBe('<font color=red>色:</font><font color=green> 青 </font>');
    });
  });

  it('最低起订量（开放接口）：合计数量不足 → CART_BELOW_MIN_ORDER_QUANTITY', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [
          { platform: '1688', url: 'https://detail.1688.com/offer/2002.html', title: 'A', quantity: 2, price: 10, minOrderQuantity: 5 },
          { platform: '1688', url: 'https://detail.1688.com/offer/2002.html', title: 'A', quantity: 1, price: 10, minOrderQuantity: 5 },
        ],
        checkProductMinOrderQuantity: true,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('CART_BELOW_MIN_ORDER_QUANTITY');
      expect(res.error.message).toContain('合计数量 3');
      expect(res.error.message).toContain('最低起订量 5');
    });
  });

  it('yanhuofba 非空归一化为 FBA', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx);
      const { deps } = makeDeps(tx);

      const res = await new AddCartService(deps).addCarts(member(user.uid), {
        goodsList: [{ platform: 'taobao', title: 'A', quantity: 1, FBA: 'anything', outId: 'OID-1', var1: 'Y' }],
      });
      expect(res.ok).toBe(true);

      const row = await (tx as unknown as { dg_cart: { findFirst: (a: unknown) => Promise<Record<string, unknown> | null> } }).dg_cart.findFirst({
        where: { uid: user.uid },
      });
      expect(row?.['yanhuofba']).toBe('FBA');
      expect(row?.['outid']).toBe('OID-1');
      expect(row?.['var1']).toBe('Y');
    });
  });
});
