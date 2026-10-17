import { legacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';

/**
 * 采购/1688/淘宝代购/砍价 域 repository 防腐层（docs/04 §5 / docs/07）。
 *
 * 本文件是 purchase 域唯一允许 import @crossbuy/db 的位置——ESLint 边界规则强制，
 * 全仓其他位置 import 即 lint error（守卫有效性由 scripts/boundary-probe.mjs 破坏验证）。
 *
 * 纪律：
 * - 旧表原样读写，禁顺手清理列名；复现怪癖必须 1:1 并登记 docs/plans/08
 * - 时间戳 Asia/Shanghai 语义；金额读入即转 Decimal（utils/money 单入口）
 * - 别域数据禁直连表：跨域读走属主域 service 接口（docs/04 §3.2-1）
 * - 写路径唯一入口 + 状态机 CAS（UPDATE ... WHERE status=from）随域铺开时落
 * - 属主旧表清单见 docs/plans/07-表属主映射.md
 */
export class PurchaseRepository {
  constructor(protected readonly db: LegacyPrismaClient = legacyPrisma) {}

  // -----------------------------------------------------------------------
  // 供应商目录（旧 Product / Order\PlatformShop）
  // -----------------------------------------------------------------------

  /** 旧 `Product::where(goods_id, platform)->first()`（加购 getProduct 的命中路径） */
  async findSupplierProduct(platform: string, goodsId: string): Promise<{ id: number } | null> {
    return this.db.v2_supplier_product.findFirst({
      where: { platform, goods_id: goodsId },
      select: { id: true },
    });
  }

  /**
   * 旧 `Product::create(array_merge(defaultInsertAttributes(), [...]))`。
   * `updated_at` 显式 null（旧代码原样），五个 JSON 列落空数组（旧默认属性）。
   */
  async createSupplierProduct(input: {
    platform: string;
    goodsId: string;
    shopId: number;
    goodsUrl: string;
    goodsName: string;
    imgUrl: string;
    price: number;
    priceRange: unknown;
    minOrderQuantity: number;
    onePieceFreePostage: number;
    sellerMixSetting: unknown;
    createdAt: Date;
  }): Promise<{ id: number }> {
    const row = await this.db.v2_supplier_product.create({
      data: {
        platform: input.platform,
        goods_id: input.goodsId,
        shop_id: input.shopId,
        goods_url: input.goodsUrl,
        goods_name: input.goodsName,
        img_url: input.imgUrl,
        price: input.price,
        price_range: input.priceRange === null ? undefined : (input.priceRange as never),
        min_order_quantity: input.minOrderQuantity,
        one_piece_free_postage: input.onePieceFreePostage,
        seller_mix_setting:
          input.sellerMixSetting === null || input.sellerMixSetting === undefined
            ? null
            : (typeof input.sellerMixSetting === 'string'
                ? input.sellerMixSetting
                : JSON.stringify(input.sellerMixSetting)),
        // 旧 defaultInsertAttributes()
        cached_detail: [],
        inspect_result: [],
        taotaro_stats: [],
        taotaro_risk: [],
        last_synced_at: input.createdAt,
        stock_status: STOCK_STATUS_ON_SALE,
        created_at: input.createdAt,
        updated_at: null,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  /** 旧 `PlatformShop::where('appid', ...)->where('openid', ...)->first()` */
  async findSupplierShopByOpenId(appid: number, openid: string): Promise<{ id: number; title: string; nickname: string | null } | null> {
    return this.db.v2_supplier_shop.findFirst({
      where: { appid, openid },
      select: { id: true, title: true, nickname: true },
    });
  }

  /** 旧 `PlatformShop::create(['appid','openid','title'])` */
  async createSupplierShop(input: { appid: number; openid: string; title: string }): Promise<{ id: number; title: string; nickname: string | null }> {
    const row = await this.db.v2_supplier_shop.create({
      data: { appid: input.appid, openid: input.openid, title: input.title, created_at: new Date() },
      select: { id: true, title: true, nickname: true },
    });
    return row;
  }

  /** 旧 `$platformShop->save()`（title 与 nickname 都可能为空） */
  async updateSupplierShop(id: number, patch: { title?: string; nickname?: string | null }): Promise<{ id: number; title: string; nickname: string | null }> {
    // updateMany：Prisma update 会回读全列（本地 dump 落后生产 schema → P2022 假故障，S21）
    await this.db.v2_supplier_shop.updateMany({ where: { id }, data: patch });
    const row = await this.db.v2_supplier_shop.findFirst({
      where: { id },
      select: { id: true, title: true, nickname: true },
    });
    return row ?? { id, title: patch.title ?? '', nickname: patch.nickname ?? null };
  }
}

/** 旧 Product::STOCK_STATUS_ON_SALE */
const STOCK_STATUS_ON_SALE = 1;
