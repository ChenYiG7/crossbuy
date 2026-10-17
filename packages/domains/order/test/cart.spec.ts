import { afterAll, describe, expect, it } from 'vitest';
import { legacyPrisma, type LegacyPrisma } from '@crossbuy/db';
import { OrderRepository } from '../src/repository';
import {
  calculateTierPrices,
  CartService,
  countMoney,
  filterMixSettingShops,
  type BenefitPort,
  type CurrencyPort,
  type MemberFactorsPort,
} from '../src/cart';
import { withRollback } from './helpers/rollback';

type Tx = LegacyPrisma.TransactionClient;

/** dg_cart 必填空串列（information_schema 核实 21 列——goodsurl/goodsname 在数据列给） */
const CART_EMPTY_COLS =
  'yanhuofba, yanhuojinyun, yanhuozengzhi, yanhuoasin, yanhuofnsku, baozhuang, hbbaozhuang, baonum, SKU, FNSKU, name, amazon, putong, fuzhuang, tiebiao, huanbaoz, qita, var1, var2, var3, var4, var5, var6, var7';

// 基址随机高位：dump 是旧库尾切片，低位 id 撞存量行（92002 已存在）
let nextGid = 98_500_000 + Math.floor(Math.random() * 100_000);
let nextProductId = 92_500_000 + Math.floor(Math.random() * 100_000);

/** dg_users（dg_cart 列表/金额因子源；dffee 起点 10，utype 0 普通） */
async function seedUser(tx: Tx, overrides: Record<string, unknown> = {}) {
  const uname = `cartuser_${Math.random().toString(36).slice(2, 8)}`;
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_users (uname, password, card, memberid, email, money, dfflag, utype, validity, dffee, state)
     VALUES (?, 'x', 'test', ?, NULL, 100, ?, ?, 0, ?, 1)`,
    uname, uname, overrides.dfflag ?? 0, overrides.utype ?? 0, overrides.dffee ?? 10,
  );
  const row = await tx.dg_users.findFirst({ where: { uname }, select: { uid: true, dfflag: true, dffee: true, utype: true } });
  expect(row).toBeTruthy();
  return { uid: row!.uid, dfflag: Number(row!.dfflag), dffee: Number(row!.dffee), utype: Number(row!.utype) };
}

/** dg_cart（占位符顺序注释锁定——上上轮 41 列对 37 值的教训） */
async function seedCart(tx: Tx, input: Record<string, unknown>) {
  const gid = nextGid++;
  // 列清单：gid, uid, supplier_product_id, type, goodsurl, goodsname, goodsprice, offer_price, retail_price,
  //         one_piece_price, sendprice, goodsnum, min_order_quantity, goodssize, goodscolor, goodsseller,
  //         goodssite, goodsid, sku_name, addtime, add_from + 必填空串列
  await tx.$executeRawUnsafe(
    `INSERT INTO dg_cart (gid, uid, supplier_product_id, type, goodsurl, goodsname, goodsprice, offer_price, retail_price,
       one_piece_price, sendprice, goodsnum, min_order_quantity, goodssize, goodscolor, goodsseller, goodssite,
       goodsid, sku_name, addtime, add_from, ${CART_EMPTY_COLS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${CART_EMPTY_COLS.split(',').map(() => `' '`).join(',')})`,
    // supplier_product_id 列 NOT NULL：无商品落 0（falsy 跳过阶梯）
    gid, input.uid, input.supplier_product_id ?? 0, input.type ?? 1, input.goodsurl ?? 'https://e.com/1',
    input.goodsname ?? 'テスト商品', input.goodsprice ?? 100, input.offer_price ?? 0, input.retail_price ?? null,
    input.one_piece_price ?? 0, input.sendprice ?? 0, input.goodsnum ?? 1, input.min_order_quantity ?? 2,
    input.goodssize ?? null, input.goodscolor ?? null, input.goodsseller ?? 'shopA', input.goodssite ?? '1688',
    input.goodsid ?? 'g1', input.sku_name ?? '', Math.floor(Date.now() / 1000), input.add_from ?? 1,
  );
  return gid;
}

/** v2_supplier_product（阶梯价/混批规则的宿主） */
async function seedProduct(tx: Tx, input: Record<string, unknown>) {
  const id = nextProductId++;
  await tx.$executeRawUnsafe(
    `INSERT INTO v2_supplier_product (id, shop_id, platform, goods_id, goods_name, price_range, min_order_quantity,
       seller_mix_setting, one_piece_free_postage, created_at)
     VALUES (?, ?, '1688', ?, ?, ?, ?, ?, ?, NOW())`,
    // shop_id NOT NULL：无店铺落 0
    id, input.shop_id ?? 0, input.goods_id ?? `p${id}`, input.goods_name ?? '商品',
    input.price_range ? JSON.stringify(input.price_range) : null,
    input.min_order_quantity ?? 2, input.seller_mix_setting ?? null, input.one_piece_free_postage ?? 0,
  );
  return id;
}

function makeFactorsPort(user: { dfflag: number; dffee: number; utype: number }): MemberFactorsPort {
  return {
    getMoneyFactors: async () => ({
      isDf: user.dfflag === 1,
      dffee: user.dffee,
      utype: user.utype,
      uname: `u_${user.dfflag}_${user.utype}`,
    }),
  };
}

const benefitPort: BenefitPort = { previewFeeDeduct: async () => null };
const currencyPort: CurrencyPort = { cnyToJpy: async () => 21.5 };

function makeService(tx: unknown, user: { dfflag: number; dffee: number; utype: number }, overrides: Record<string, unknown> = {}) {
  return new CartService({
    repository: new OrderRepository(tx as never),
    memberFactorsPort: makeFactorsPort(user),
    benefitPort: (overrides.benefitPort as BenefitPort) ?? benefitPort,
    currencyPort,
    feeDeductPreviewEnabled: (overrides.feeDeductPreviewEnabled as boolean) ?? false,
    utypeCharged: 1,
  });
}

function memberPrincipal(uid: number) {
  return { subject: String(uid), kind: 'member' as const };
}

describe('购物车列表（listCart 1:1）', () => {
  it('普通用户：type∈[1,2] 可见，代发单（type=3）不可见；ids 过滤生效', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 0 });
      await seedCart(tx, { uid: user.uid, type: 1 });
      const hiddenDf = await seedCart(tx, { uid: user.uid, type: 3 });
      const keep = await seedCart(tx, { uid: user.uid, type: 2 });

      const svc = makeService(tx, user);
      const all = await svc.listCarts(memberPrincipal(user.uid), {});
      expect(all.ok).toBe(true);
      if (all.ok) {
        const gids = all.value.flatMap((g) => g.carts.map((c) => c.gid));
        expect(gids).not.toContain(hiddenDf);
        expect(gids).toContain(keep);
      }

      const filtered = await svc.listCarts(memberPrincipal(user.uid), { ids: String(keep) });
      expect(filtered.ok).toBe(true);
      if (filtered.ok) {
        const gids = filtered.value.flatMap((g) => g.carts.map((c) => c.gid));
        expect(gids).toEqual([keep]);
      }
    });
  });

  it('DF 用户（dfflag=1）：只看 type=3', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 1 });
      await seedCart(tx, { uid: user.uid, type: 1 });
      const df = await seedCart(tx, { uid: user.uid, type: 3 });

      const svc = makeService(tx, user);
      const result = await svc.listCarts(memberPrincipal(user.uid), {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        const gids = result.value.flatMap((g) => g.carts.map((c) => c.gid));
        expect(gids).toEqual([df]);
      }
    });
  });

  it('按卖家分组 + 同 sku 桶聚拢（ sellers 首现序）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 0 });
      // 同卖家 shopA 两行（不同 sku → 不同桶），shopB 一行
      await seedCart(tx, { uid: user.uid, type: 1, goodsseller: 'shopA', goodsid: 'g1', sku_name: '' });
      await seedCart(tx, { uid: user.uid, type: 1, goodsseller: 'shopB', goodsid: 'g2', sku_name: '' });
      await seedCart(tx, { uid: user.uid, type: 1, goodsseller: 'shopA', goodsid: 'g1', sku_name: '' });

      const svc = makeService(tx, user);
      const result = await svc.listCarts(memberPrincipal(user.uid), {});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        const sellers = result.value.map((g) => g.goodsSeller);
        expect(sellers).toEqual(['shopA', 'shopB']); // 首现序
        expect(result.value[0]!.carts).toHaveLength(2);
        expect(result.value[0]!.goodsSite).toBe('1688');
      }
    });
  });
});

describe('金额计算（countMoney + 阶梯价 1:1）', () => {
  it('代购：5% 服务费 ceil；付费会员（UTYPE_CHARGED）服务费归零', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 0, utype: 0 });
      const gid = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 3 });
      const rows = await new OrderRepository(tx as never).listCarts(tx, { uid: user.uid, types: [1, 2] });
      const products = new Map();

      const money = countMoney(rows, products, false, user.dffee, null);
      expect(money.goodsMoney).toBe(300);
      expect(money.originalServerMoney).toBe(Math.ceil(300 * 0.05 * 100) / 100); // 15
      expect(money.serverMoney).toBe(15);
      expect(money.totalMoney).toBe(315);
      void gid;

      // 付费会员：服务费归零（goodsMoney 不变）
      const charged = countMoney(rows, products, true, user.dffee, null);
      expect(charged.serverMoney).toBe(0);
      expect(charged.totalMoney).toBe(300);
    });
  });

  it('代发：服务费 = dffee × 件数', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 1, dffee: 10 });
      await seedCart(tx, { uid: user.uid, type: 3, goodsprice: 50, goodsnum: 4 });
      const rows = await new OrderRepository(tx as never).listCarts(tx, { uid: user.uid, types: [3] });

      const money = countMoney(rows, new Map(), false, user.dffee, null);
      expect(money.goodsMoney).toBe(200);
      expect(money.serverMoney).toBe(40);
      expect(money.originalServerMoney).toBe(40);
    });
  });

  it('阶梯价：合计 1 件用 retail_price；≥startQuantity 用阶梯价；单组 price_range 不算阶梯', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 0 });
      // 同商品合计 3 件（goodsprice 100 / 两组阶梯：3件→90、2件→95——单组不算阶梯是旧语义）
      const pid = await seedProduct(tx, {
        price_range: [{ startQuantity: 3, price: 90 }, { startQuantity: 2, price: 95 }],
        min_order_quantity: 2,
      });
      await seedCart(tx, { uid: user.uid, type: 1, supplier_product_id: pid, goodsprice: 100, goodsnum: 3 });
      // 单件 + retail_price 95
      const pid2 = await seedProduct(tx, { price_range: [{ startQuantity: 2, price: 90 }], min_order_quantity: 2 });
      await seedCart(tx, { uid: user.uid, type: 1, supplier_product_id: pid2, goodsprice: 100, goodsnum: 1, retail_price: 95 });
      // 单组 price_range → 原价
      const pid3 = await seedProduct(tx, { price_range: [{ startQuantity: 5, price: 80 }], min_order_quantity: 2 });
      await seedCart(tx, { uid: user.uid, type: 1, supplier_product_id: pid3, goodsprice: 100, goodsnum: 10 });

      const rows = await new OrderRepository(tx as never).listCarts(tx, { uid: user.uid, types: [1, 2] });
      const products = await new OrderRepository(tx as never).listSupplierProducts(
        tx,
        rows.map((r) => r.supplier_product_id!).filter(Boolean),
      );
      const tier = calculateTierPrices(rows, products);
      const values = [...tier.values()];
      expect(values).toContain(90); // 阶梯（合计 3 件 → 3 件档）
      expect(values).toContain(95); // 单件零售
      expect(values).toContain(100); // 单组不算
    });
  });

  it('混批：店铺金额达标 → 不满足起批回原价（filterMixSettingShops + 混批分支）', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 0 });
      const pid = await seedProduct(tx, {
        shop_id: 777,
        price_range: [{ startQuantity: 10, price: 80 }],
        min_order_quantity: 2,
        seller_mix_setting: JSON.stringify({ mixAmount: 500 }),
      });
      // 同店铺另一商品凑混批金额（600）
      const pidMate = await seedProduct(tx, { shop_id: 777, price_range: null, min_order_quantity: 2 });
      await seedCart(tx, { uid: user.uid, type: 1, supplier_product_id: pidMate, goodsprice: 600, goodsnum: 1 });
      // 目标商品 2 件 < startQuantity 10，但店铺混批达标 → 原价 100
      await seedCart(tx, { uid: user.uid, type: 1, supplier_product_id: pid, goodsprice: 100, goodsnum: 2 });

      const rows = await new OrderRepository(tx as never).listCarts(tx, { uid: user.uid, types: [1, 2] });
      const products = await new OrderRepository(tx as never).listSupplierProducts(
        tx,
        rows.map((r) => r.supplier_product_id!).filter(Boolean),
      );
      const tier = calculateTierPrices(rows, products);
      // 目标商品 gid 的单价 = 100（混批原价），不是阶梯 80
      const target = rows.find((r) => r.supplier_product_id === pid)!;
      expect(tier.get(target.gid)).toBe(100);
      void user;
    });
  });

  it('getCartMoney 端到端：服务费 5% + 汇率换算；DF 用户走 dffee 分支', async () => {
    await withRollback(async (tx0) => {
      const tx = tx0 as Tx;
      const user = await seedUser(tx, { dfflag: 0 });
      const gid = await seedCart(tx, { uid: user.uid, type: 1, goodsprice: 100, goodsnum: 2 });

      const svc = makeService(tx, user);
      const result = await svc.getCartMoney(memberPrincipal(user.uid), { ids: String(gid) });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.goodsMoney).toBe('200.00');
        expect(result.value.serverMoney).toBe('10.00'); // ceil(200*0.05)
        expect(result.value.totalMoney).toBe('210.00');
        expect(result.value.exchangeMoney).toBe('4515.00'); // 210 × 21.5
      }
    });
  });

  it('filterMixSettingShops：金额与件数双通道判定', () => {
    const shops = new Map([
      [1, { num: 5, money: 600, rule: { mixAmount: 500 } }],
      [2, { num: 20, money: 100, rule: { mixNumber: 10 } }],
      [3, { num: 1, money: 100, rule: { mixAmount: 500, mixNumber: 10 } }],
    ]);
    const ids = filterMixSettingShops(shops);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
  });
});

afterAll(async () => {
  await legacyPrisma.$disconnect();
});
