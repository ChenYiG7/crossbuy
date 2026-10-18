import type { PurchaseRepository } from './repository';
import type { SupplierProductRead, SupplierShopRead } from '@crossbuy/contract';

/**
 * 供应商目录（旧 `Product`（v2_supplier_product）+ `Order\PlatformShop`（v2_supplier_shop））。
 *
 * ★ 表属主：`v2_supplier_product` / `v2_supplier_shop` 在 `docs/plans/07` §四 归 **purchase**
 *   （high 置信）⇒ 加购链路（order 域）需要读写这两张表时**只能走本服务端口**，
 *   不能把 SQL 搬到 order 域（表唯一属主铁律；order 域历史包袱见 TODO(#17)）。
 *
 * 语义锚点（1:1 复现，动前先读）：
 * - 旧 `AddCartMutation::getProduct`：**先查**（命中直接返回，不抢锁）→ 未命中才抢
 *   `sync_product_lock_product_id:{goodsId}`（TTL 10s / block 5s）→ 锁内再查 → 仍无才建。
 *   锁超时 → 兜底再查一次 → 还没有就抛 service_busy（本服务返回 null + 错误）。
 * - 旧 `Product::defaultInsertAttributes()`：`cached_detail/inspect_result/taotaro_stats/
 *   taotaro_risk = []`、`last_synced_at = now()`、`stock_status = STOCK_STATUS_ON_SALE(1)`。
 * - 旧 `Product::create(... 'updated_at' => null)`——显式置空，不是「不传」。
 * - 旧店铺映射（PlatformShop）三件事：缺 nickname 时用 SDK 反解补全；title 与
 *   nickname/openid 相同时**清洗成空串**；最后以 `title ?: nickname` 作为买家名。
 */

/** 平台枚举（旧 Product::TYPE_TAOBAO / TYPE_1688） */
export const SUPPLIER_PLATFORM = {
  TAOBAO: 'taobao',
  TAOBAO_GLOBAL: 'taobao_global',
  ALIBABA_1688: '1688',
} as const;

/** 旧 Product::STOCK_STATUS_ON_SALE */
const STOCK_STATUS_ON_SALE = 1;

/** 建商品入参（旧 Product::create 的字段集 1:1） */
export interface CreateSupplierProductInput {
  platform: string;
  goodsId: string;
  shopId: number;
  goodsUrl: string;
  goodsName: string;
  imgUrl: string;
  price: number;
  /** 旧 getPriceRange 校验后的阶梯；格式不合法 = null（不落库） */
  priceRange: Array<{ price: unknown; startQuantity: unknown }> | null;
  minOrderQuantity: number;
  onePieceFreePostage: number;
  /** 旧 `json_decode($goodsInfo['sellerMixSetting'], true)`；非法 JSON = null */
  sellerMixSetting: unknown | null;
}

/**
 * 分布式锁端口（旧 `Cache::lock(key, ttl)->block(wait)`）。
 * R1 组合根给**进程内**实现（单实例正确），多实例部署前必须换 Redis（TODO(#16)）。
 */
export interface CatalogLockPort {
  /**
   * 取锁执行；抢不到（超时）返回 false——调用方按旧 LockTimeoutException 分支兜底。
   */
  withLock<T>(
    key: string,
    ttlSeconds: number,
    waitSeconds: number,
    fn: () => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }>;
}

export interface SupplierCatalogService {
  readonly domain: 'purchase';

  /**
   * 旧 `AddCartMutation::getProduct` 1:1。
   * @returns 命中/新建的商品 id；goodsid 为空或平台非淘宝/1688 → null（旧 `return null`）
   */
  resolveOrCreateProduct(input: CreateSupplierProductInput): Promise<{ id: number } | null>;

  /** 旧 `PlatformShop::where(appid, openid)->first()` */
  findShopByOpenId(appid: number, openid: string): Promise<SupplierShop | null>;

  /** 旧 `PlatformShop::create(['appid','openid','title'])` */
  createShop(input: { appid: number; openid: string; title: string }): Promise<SupplierShop>;

  /** 旧 `$platformShop->save()`（title/nickname 都可能为空） */
  updateShop(
    id: number,
    patch: { title?: string; nickname?: string | null },
  ): Promise<SupplierShop>;

  /**
   * 批量读供应商商品（只读；旧 with(['supplierProduct']) 的 R1 子集列）。
   * 跨域（order 域）只读 purchase 属主表的入口（表唯一属主铁律，TODO #17）。
   */
  listProductsByIds(ids: number[]): Promise<Map<number, SupplierProductRead>>;

  /** 批量读供应商店铺（只读；title/nickname 用于买家名展示） */
  listShopsByIds(ids: number[]): Promise<Map<number, SupplierShopRead>>;
}

/** 店铺映射行（旧 PlatformShop；`title`/`nickname` 均可空） */
export interface SupplierShop {
  id: number;
  /** 旧表 `title` NOT NULL 无默认——历史清洗分支置的是空串而非 NULL */
  title: string;
  nickname: string | null;
  /** 旧「使用 title 或 nickname 作为买家名」：`title !== '' ? title : nickname` */
  displayName: string | null;
}

export interface SupplierCatalogDeps {
  repository: PurchaseRepository;
  lockPort: CatalogLockPort;
  /** 注入时钟（默认真实时间） */
  clock?: () => Date;
}

/** 旧 Product::syncLockKey($goodsId) */
export function productSyncLockKey(goodsId: string): string {
  return `sync_product_lock_product_id:${goodsId}`;
}

/** 旧 getPriceRange：json_decode 后必须是数组，且每项同时含 price 与 startQuantity */
export function parsePriceRange(
  raw: string | null | undefined,
): Array<{ price: unknown; startQuantity: unknown }> | null {
  if (!raw) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length === 0) return null;
  for (const item of decoded) {
    if (typeof item !== 'object' || item === null) return null;
    if (!('price' in item) || !('startQuantity' in item)) return null;
  }
  return decoded as Array<{ price: unknown; startQuantity: unknown }>;
}

export class SupplierCatalogServiceImpl implements SupplierCatalogService {
  readonly domain = 'purchase' as const;

  constructor(protected readonly deps: SupplierCatalogDeps) {}

  async resolveOrCreateProduct(input: CreateSupplierProductInput): Promise<{ id: number } | null> {
    if (input.goodsId === '') return null;
    // 已存在则无需抢锁，降低与 syncProduct / 并发加购的锁竞争（旧注释原话）
    const existing = await this.deps.repository.findSupplierProduct(input.platform, input.goodsId);
    if (existing) return { id: existing.id };

    const lock = await this.deps.lockPort.withLock(
      productSyncLockKey(input.goodsId),
      10,
      5,
      async () => {
        const again = await this.deps.repository.findSupplierProduct(input.platform, input.goodsId);
        if (again) return { id: again.id };
        const created = await this.deps.repository.createSupplierProduct({
          platform: input.platform,
          goodsId: input.goodsId,
          shopId: input.shopId,
          goodsUrl: input.goodsUrl,
          goodsName: input.goodsName,
          imgUrl: input.imgUrl,
          price: input.price,
          priceRange: input.priceRange,
          minOrderQuantity: input.minOrderQuantity,
          onePieceFreePostage: input.onePieceFreePostage,
          sellerMixSetting: input.sellerMixSetting,
          createdAt: (this.deps.clock ?? (() => new Date()))(),
        });
        return { id: created.id };
      },
    );
    if (lock.acquired && lock.value) return lock.value;

    // 旧 LockTimeoutException 分支：其他请求可能已创建成功 → 兜底再查一次
    const fallback = await this.deps.repository.findSupplierProduct(input.platform, input.goodsId);
    if (fallback) return { id: fallback.id };
    return null;
  }

  async findShopByOpenId(appid: number, openid: string): Promise<SupplierShop | null> {
    const row = await this.deps.repository.findSupplierShopByOpenId(appid, openid);
    return row ? withDisplayName(row) : null;
  }

  async createShop(input: { appid: number; openid: string; title: string }): Promise<SupplierShop> {
    const row = await this.deps.repository.createSupplierShop(input);
    return withDisplayName(row);
  }

  async updateShop(
    id: number,
    patch: { title?: string; nickname?: string | null },
  ): Promise<SupplierShop> {
    const row = await this.deps.repository.updateSupplierShop(id, patch);
    return withDisplayName(row);
  }

  async listProductsByIds(ids: number[]): Promise<Map<number, SupplierProductRead>> {
    if (ids.length === 0) return new Map();
    const rows = await this.deps.repository.findSupplierProductsByIds(ids);
    return new Map(rows.map((r) => [r.id, r]));
  }

  async listShopsByIds(ids: number[]): Promise<Map<number, SupplierShopRead>> {
    if (ids.length === 0) return new Map();
    const rows = await this.deps.repository.findSupplierShopsByIds(ids);
    return new Map(rows.map((r) => [r.id, { title: r.title, nickname: r.nickname }]));
  }
}

function withDisplayName(row: {
  id: number;
  title: string;
  nickname: string | null;
}): SupplierShop {
  return {
    id: row.id,
    title: row.title,
    nickname: row.nickname,
    displayName: row.title !== '' ? row.title : row.nickname,
  };
}
