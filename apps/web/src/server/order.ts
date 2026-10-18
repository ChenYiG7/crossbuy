import {
  createInMemoryCooldown,
  createInMemoryLock,
  createInMemoryTtlCache,
  createRedis,
  createRedisCooldown,
  createRedisLock,
  createRedisTtlCache,
  type CooldownStore,
  type DistributedLock,
  type TtlCache,
} from '@crossbuy/cache';
import { Queue } from 'bullmq';
import { createConnection, DEFAULT_JOB_OPTIONS, QUEUES } from '@crossbuy/jobs';
import { MemberRepository } from '@crossbuy/domain-member';
import {
  AddCartService,
  CartService,
  OrderRepository,
  OrderServiceImpl,
  PlaceOrderService,
  runInOrderTransaction,
  type AddCartMemberPort,
  type AddCartSideEffectPort,
  type AlibabaShopPort,
  type BenefitPort,
  type CartService as CartServiceType,
  type CurrencyPort,
  type DaifaSendOrderPort,
  type FrontendUrlPort,
  type GoodsPriceRefreshPort,
  type GoodsUrlParserPort,
  type MemberFactorsPort,
  type OrderService,
  type PlatformGoodsInfoPort,
  type PlaceOrderBenefitPort,
  type PlaceOrderSideEffectPort,
  type ProcessLockPort,
  type SkuTranslationPort,
  type SupplierProductPort,
  type SupplierShopPort,
} from '@crossbuy/domain-order';
import { FinanceServiceImpl, FinanceRepository } from '@crossbuy/domain-finance';
import {
  AlibabaAccessServiceImpl,
  PurchaseRepository,
  SupplierCatalogServiceImpl,
  type AlibabaAccessService,
  type CatalogLockPort,
  type SupplierCatalogService,
} from '@crossbuy/domain-purchase';
import { SendOrderRepository, SendOrderServiceImpl } from '@crossbuy/domain-send-order';
import { getMemberService } from './member';

/**
 * order 域组合根（apps/web 唯一装配处）：域实现在这里接线，
 * 路由/页面只拿接口。事务运行器 = 真事务（生产语义，域出口提供）。
 */
let orderService: OrderService | null = null;

export function getOrderService(): OrderService {
  orderService ??= new OrderServiceImpl(
    new OrderRepository(), // 默认 legacyPrisma 单例（域内默认值，app 不直接触 db）
    () => new Date(),
    runInOrderTransaction,
  );
  return orderService;
}

// ---------------------------------------------------------------------------
// cart 读路径组合根（dg_cart 属主 = order 域；v2_supplier_product / v2_supplier_shop
// 属主 = purchase 域，只读经 SupplierCatalogService 跨域端口接线，TODO #17）
// ---------------------------------------------------------------------------

/**
 * 供应商目录服务（purchase 域）：order 域只读 v2_supplier_product / v2_supplier_shop 的唯一入口。
 * 单例（stateless，仅持依赖），cart / 下单两条链路共用。
 */
let supplierCatalogService: SupplierCatalogService | null = null;
function getSupplierCatalog(): SupplierCatalogService {
  supplierCatalogService ??= new SupplierCatalogServiceImpl({
    repository: new PurchaseRepository(),
    lockPort: createCatalogLock(),
  });
  return supplierCatalogService;
}

let cartService: CartServiceType | null = null;

export function getCartService(): CartServiceType {
  cartService ??= (() => {
    // 会员因子端口（dg_users 属主 = member 域；Result → 裸值适配）
    const memberFactorsPort: MemberFactorsPort = {
      getMoneyFactors: async (uid) => {
        const result = await getMemberService().getMoneyFactors(uid);
        return result.ok ? result.value : null;
      },
    };
    // 权益预览端口：benefit 域 R1 未迁移 → 恒 null（= 无可用权益，与旧 previewFeeDeduct
    // 无权益时返回 null 同形；开关默认关——旧 config env FEE_DEDUCT_PREVIEW_SWITCH 缺省 null）
    const benefitPort: BenefitPort = {
      previewFeeDeduct: async () => null,
    };
    // 汇率端口（dg_huilv 属主 = finance 域；3 分钟缓存语义在 service 内）
    const finance = new FinanceServiceImpl(new FinanceRepository());
    const currencyPort: CurrencyPort = {
      cnyToJpy: () => finance.getCnyToJpyRate(),
    };
    return new CartService({
      repository: new OrderRepository(),
      memberFactorsPort,
      benefitPort,
      currencyPort,
      // 供应商目录只读（v2_supplier_product / v2_supplier_shop 属主 = purchase 域）
      supplierCatalog: getSupplierCatalog(),
      // 旧 config('benefit.fee_deduct_preview_switch') !== null
      feeDeductPreviewEnabled: process.env.FEE_DEDUCT_PREVIEW_SWITCH != null,
      // 旧 User::UTYPE_CHARGED（付费会员）
      utypeCharged: Number(process.env.UTYPE_CHARGED ?? 1),
    });
  })();
  return cartService;
}

// ---------------------------------------------------------------------------
// 加购链路组合根（旧 AddCartMutation）
// ---------------------------------------------------------------------------

/**
 * 商品 URL 解析（旧 `ContentParser::parse` —— 淘宝/1688 双解析器 + 1 分钟 Cache）。
 *
 * ⚠ R1 是**正则兜底**实现（S39）：旧解析器是独立库（含页面抓取与类型排序权重），
 * 未迁移；只覆盖最常见的 `id=`/`offer/{id}.html`/`item.htm?id=` 形态，取不到就回退
 * `''`（= 旧「无法解析 goodsid，跳过平台实价覆盖」分支，不阻断加购）。
 * 迁移后只换本函数。
 */
function createUrlParser(): GoodsUrlParserPort {
  return {
    async parse(url) {
      const itemId =
        /[?&]id=(\d+)/.exec(url)?.[1] ??
        /offer\/(\d+)\.html/.exec(url)?.[1] ??
        /item\.htm\?[^#]*\bid=(\d+)/.exec(url)?.[1] ??
        '';
      const miId = /[?&]mi_id=([^&]+)/.exec(url)?.[1] ?? '';
      if (itemId === '') return [];
      return [{ detail: { itemId, miId: miId === '' ? null : miId } }];
    },
  };
}

// ---------------------------------------------------------------------------
// 分布式闸门（Redis）——TODO(#16) 收口：进程内 Map 只在单实例下成立
// ---------------------------------------------------------------------------

type RedisClient = ReturnType<typeof createRedis>;

let redisClient: RedisClient | null = null;
let redisResolved = false;
let fallbackWarned = false;

/**
 * Redis 单例（懒连）。返回 null = 未配置 ⇒ 调用方走进程内回退。
 *
 * ⚠ `error` 事件**必须**订阅：ioredis 不订阅会把连接错误抛成未捕获异常直接打挂进程；
 * 而静默吞掉同样危险——「以为在用 Redis 其实连不上」正是闸门最坏的状态。
 */
function resolveRedis(): RedisClient | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (!redisResolved) {
    redisResolved = true;
    redisClient = createRedis(url);
    redisClient.on('error', (e: Error) => {
      console.error(
        '[redis] 连接错误：下单/目录闸门可能不可用（fail-closed，请求会被拒）',
        e.message,
      );
    });
  }
  return redisClient;
}

/** 取锁/冷却实现；无 REDIS_URL 时退化为进程内（并报警，绝不静默） */
function gates(): { lock: DistributedLock; cooldown: CooldownStore } {
  const redis = resolveRedis();
  if (redis) return { lock: createRedisLock(redis), cooldown: createRedisCooldown(redis) };
  if (!fallbackWarned) {
    fallbackWarned = true;
    console.warn(
      '[order] REDIS_URL 未配置 → 下单/目录闸门退化为**进程内**实现；单实例正确，多实例部署会失效（TODO(#16)）',
    );
  }
  return { lock: createInMemoryLock(), cooldown: createInMemoryCooldown() };
}

/**
 * 进程内目录锁实现（旧 `Cache::lock(...)->block(5)`；无 Redis 时的回退，语义与 Redis 一致）。
 * 有 REDIS_URL 时由 `createCatalogLock()` 走 Redis，见下。
 */
function createInMemoryCatalogLock(): CatalogLockPort {
  const lock = createInMemoryLock();
  return {
    async withLock(key, ttlSeconds, waitSeconds, fn) {
      const r = await lock.withLock(
        key,
        { ttlMs: ttlSeconds * 1000, waitMs: waitSeconds * 1000 },
        fn,
      );
      return r.acquired ? { acquired: true, value: r.value } : { acquired: false };
    },
  };
}

/** 目录锁（加购链路）：有 Redis 则跨实例互斥，否则回退进程内 */
function createCatalogLock(): CatalogLockPort {
  const redis = resolveRedis();
  if (!redis) return createInMemoryCatalogLock();
  const lock = createRedisLock(redis);
  return {
    async withLock(key, ttlSeconds, waitSeconds, fn) {
      const r = await lock.withLock(
        key,
        { ttlMs: ttlSeconds * 1000, waitMs: waitSeconds * 1000 },
        fn,
      );
      return r.acquired ? { acquired: true, value: r.value } : { acquired: false };
    },
  };
}

let addCartService: AddCartService | null = null;

export function getAddCartService(): AddCartService {
  addCartService ??= (() => {
    const repository = new OrderRepository();
    const memberPort: AddCartMemberPort = {
      getMoneyFactors: async (uid) => {
        const result = await getMemberService().getMoneyFactors(uid);
        return result.ok ? result.value : null;
      },
    };
    // 平台商品详情：R1 SDK（淘宝/1688）未迁移 → 恒 null（S40，= 旧「拉取失败保留前端价」）
    const platformGoods: PlatformGoodsInfoPort = { fetch: async () => null };
    // 1688 店铺反解：R1 SDK 未迁移 → 恒 null（S41，整段映射逻辑不触发）
    const alibabaShop: AlibabaShopPort = {
      searchShopNameByGoodsId: async () => null,
      decryptOpenidFromFenxiaoApi: async () => null,
    };
    // 供应商商品/店铺：v2_supplier_product / v2_supplier_shop 属主 = purchase 域（表唯一属主）
    const catalog = new SupplierCatalogServiceImpl({
      repository: new PurchaseRepository(),
      lockPort: createCatalogLock(),
    });
    const supplierProduct: SupplierProductPort = {
      resolveOrCreate: (input) => catalog.resolveOrCreateProduct(input),
    };
    const supplierShop: SupplierShopPort = {
      findByOpenId: (appid, openid) => catalog.findShopByOpenId(appid, openid),
      create: (appid, openid, title) => catalog.createShop({ appid, openid, title }),
      update: (id, patch) => catalog.updateShop(id, patch),
    };
    // 加购后 Job：队列未接线 → no-op（TODO(#16)，随 worker 真 Job 落地）
    const sideEffects: AddCartSideEffectPort = {
      enqueueSyncSupplierProduct: async () => undefined,
      enqueueSubscribeSupplierProduct: async () => undefined,
      enqueueCompletionGoodsInfoForCart: async () => undefined,
      enqueueTranslateCartGoodsInfo: async () => undefined,
    };
    // 旧 getFrontendUrl($path, $dfflag, false)（is1688Japan=false 分支）
    const frontendUrl: FrontendUrlPort = {
      build: (path, isDf) => {
        const host = isDf
          ? (process.env.PUBLIC_MZK_URL_PREFIX ?? 'https://mzk-v2.yiwutaro.com')
          : (process.env.PUBLIC_URL_PREFIX ?? 'https://www.yiwutaro.com');
        return `${host.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
      },
    };
    return new AddCartService({
      repository,
      memberPort,
      urlParser: createUrlParser(),
      platformGoods,
      alibabaShop,
      supplierProduct,
      supplierShop,
      sideEffects,
      frontendUrl,
      // 旧 env('ALIBABA_FENXIAO_APPID')
      alibabaFenxiaoAppid: Number(process.env.ALIBABA_FENXIAO_APPID ?? 0),
      // 旧 env('CART_MAX_COUNT', 10000)
      cartMaxCount: Number(process.env.CART_MAX_COUNT ?? 10000),
    });
  })();
  return addCartService;
}

// ---------------------------------------------------------------------------
// 下单链路组合根（旧 CreateOrderMutation + CreateOrderFromCartService）
// ---------------------------------------------------------------------------

/**
 * 重复下单闸门（旧 `Cache::has` / `Cache::put` / `Cache::lock` 的 R1 实现）。
 *
 * 默认走 **Redis**（跨实例互斥，TODO(#16) 的收口）；未配 `REDIS_URL` 时回退进程内实现
 * 并打 WARNING——接口与域解耦，换实现只改本文件，域代码零感知。
 *
 * ⚠ token 为什么存在这里：域端口 `release(key)` **不带 token**（旧 `Cache::lock` 也没这概念），
 * 而 Redis 释放必须带 token 才不会误删别人的锁。token 只需持锁进程自己知道，
 * 所以进程内 Map 是**正确**的——跨实例安全性由 Redis 里那份 token 保证，不靠这张 Map。
 */
function createProcessLock(): ProcessLockPort {
  const { lock, cooldown } = gates();
  const tokens = new Map<string, string>();
  return {
    has: (key) => cooldown.has(key),
    put: (key, ttlSeconds) => cooldown.put(key, Math.round(ttlSeconds * 1000)),
    async acquire(key, ttlSeconds) {
      const token = await lock.acquire(key, Math.round(ttlSeconds * 1000));
      if (token === null) return false;
      tokens.set(key, token);
      return true;
    },
    async release(key) {
      const token = tokens.get(key);
      if (token === undefined) return;
      tokens.delete(key);
      await lock.release(key, token);
    },
  };
}

// 下单成功邮件队列（#16② enqueueOrderCreated 入队；worker 消费后发信）。
// 与 gate 同一 REDIS_URL；无配置则降级为「不发邮件」（副作用 best-effort，绝不阻断下单事务）。
let orderCreatedQueue: Queue | null = null;
let orderQueueWarned = false;
function getOrderCreatedQueue(): Queue | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (!orderQueueWarned) {
      orderQueueWarned = true;
      console.warn(
        '[order] REDIS_URL 未配置 → 下单成功邮件将不发送（enqueueOrderCreated 降级为 no-op，不阻断下单）',
      );
    }
    return null;
  }
  if (!orderCreatedQueue) {
    orderCreatedQueue = new Queue(QUEUES.orderCreated, { connection: createConnection(url) });
  }
  return orderCreatedQueue;
}

// ---------------------------------------------------------------------------
// 1688 SDK 接入（purchase 域）： fenxiao 分销详情缓存 + 规格翻译端口（S35 收口）
// ---------------------------------------------------------------------------

/**
 * 分销详情 TTL 缓存（旧 Laravel `Cache` 1h，依托 @crossbuy/cache）。
 * 与闸门同一 REDIS_URL；无配置退内存 + WARNING（ degradation 只降命中率，不涉正确性，
 * 与闸门的 fail-closed 不同——但同样绝不静默）。
 */
let fenxiaoCacheResolved: TtlCache | null = null;
function resolveFenxiaoCache(): TtlCache {
  if (fenxiaoCacheResolved) return fenxiaoCacheResolved;
  const redis = resolveRedis();
  if (redis) {
    fenxiaoCacheResolved = createRedisTtlCache(redis);
    return fenxiaoCacheResolved;
  }
  console.warn(
    '[order] REDIS_URL 未配置 → 1688 分销详情缓存退化为**进程内**实现（多实例各算各的命中率，不影响正确性）',
  );
  fenxiaoCacheResolved = createInMemoryTtlCache();
  return fenxiaoCacheResolved;
}

/**
 * purchase 域 1688 接入面单例（stateless，仅持依赖）。
 * 凭证链：主组 env（fenxiao 详情恒主组、无轮换）→ findAutoCreatedSubAccountId 端口给
 * 订单面（getOrderDetail）用；本组合根里 web 只消费 fenxiao 详情（规格翻译）。
 */
let alibabaAccessService: AlibabaAccessService | null = null;
function getAlibabaAccess(): AlibabaAccessService {
  alibabaAccessService ??= (() => {
    const purchaseRepo = new PurchaseRepository();
    const orderRepo = new OrderRepository(); // 只用 findAutoCreatedSubAccountId（order 属主表）
    return new AlibabaAccessServiceImpl({
      findAutoCreatedSubAccountId: (tradeId) => orderRepo.findAutoCreatedSubAccountId(tradeId),
      findSubAccountById: (id) => purchaseRepo.findSubAccountById(id),
      findSubAccountByUsername: (username) => purchaseRepo.findSubAccountByUsername(username),
      upsertSubAccountToken: (username, accessToken) =>
        purchaseRepo.upsertSubAccountToken(username, accessToken, new Date()),
      envGet: (key) => process.env[key],
      fenxiaoCache: resolveFenxiaoCache(),
    });
  })();
  return alibabaAccessService;
}

/** 旧 PHP `empty()`：'' / '0' / 0 / null / false 都算空（CreateOrderFromCartService:443 同义） */
function phpEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  return value === '' || value === '0' || value === 0;
}

/**
 * 规格翻译端口实现（旧 `CreateOrderFromCartService::getAlibabaSkuAttributes` 1:1）：
 * fenxiao 分销详情 → `productSkuInfos` 匹配 skuId → 其 `skuAttributes` → `[{name,value}]`。
 *
 * - memo（旧 `$this->propTranslationMaps`）：key = `goodsId:skuId`，失败/未命中都记
 *   `[]`，同一请求不重复打网关。★ 旧 memo 每请求重建故无上限；本类是单例 ⇒ 加
 *   1000 条上限清空兜底（防长生命周期累积，语义只影响命中率不影响正确性）。
 * - 空 skuId ⇒ 直接 `[]` 不发请求（旧同）；网关失败/凭证缺失 ⇒ `[]`（旧 catch 同）。
 * - name/value 用旧 `empty()` 判跳过（'0' 也算空——1:1 不修）。
 */
class FenxiaoSkuTranslationPort implements SkuTranslationPort {
  private readonly memo = new Map<string, Array<{ name: string; value: string }>>();
  private static readonly MEMO_LIMIT = 1000;

  constructor(private readonly access: AlibabaAccessService) {}

  async attributesFor(
    goodsId: string,
    skuId: string,
  ): Promise<Array<{ name: string; value: string }> | null> {
    const memoKey = `${goodsId}:${skuId}`;
    const cached = this.memo.get(memoKey);
    if (cached !== undefined) return cached;
    if (this.memo.size >= FenxiaoSkuTranslationPort.MEMO_LIMIT) this.memo.clear();

    const props: Array<{ name: string; value: string }> = [];
    if (skuId !== '') {
      const res = await this.access.getFenxiaoDetail(goodsId);
      if (res.code === 200) {
        const skuInfos = res.data.result?.['productSkuInfos'];
        if (Array.isArray(skuInfos)) {
          for (const skuInfo of skuInfos) {
            const row =
              skuInfo !== null && typeof skuInfo === 'object'
                ? (skuInfo as Record<string, unknown>)
                : null;
            if (row === null) continue;
            if (String(row['skuId'] ?? '') !== skuId) continue; // 旧 (string) 强转比对
            const attributes = row['skuAttributes'];
            if (Array.isArray(attributes)) {
              for (const attr of attributes) {
                const a =
                  attr !== null && typeof attr === 'object'
                    ? (attr as Record<string, unknown>)
                    : null;
                if (a === null) continue;
                const name = a['attributeName'];
                const value = a['value'];
                if (phpEmpty(name) || phpEmpty(value)) continue;
                props.push({ name: String(name), value: String(value) });
              }
            }
            break; // 旧命中 skuId 即 break（无 attributes 也断，不再找同名 SKU）
          }
        }
      }
    }
    this.memo.set(memoKey, props);
    return props;
  }
}

let placeOrderService: PlaceOrderService | null = null;

export function getPlaceOrderService(): PlaceOrderService {
  placeOrderService ??= (() => {
    const repository = new OrderRepository();
    // 实时价刷新：R1 SDK（淘宝/1688 商品详情）未迁移 → no-op（S34 登记）
    const goodsPriceRefreshPort: GoodsPriceRefreshPort = { refresh: async () => undefined };
    // 规格翻译：fenxiao 分销详情 SDK 已接线（S35 收口，2026-10-18）；失败 ⇒ []（旧分支）
    const skuTranslationPort: SkuTranslationPort = new FenxiaoSkuTranslationPort(
      getAlibabaAccess(),
    );
    // 权益：benefit 域 R1 未迁移 → 恒 null / no-op（S35 登记）
    const benefitPort: PlaceOrderBenefitPort = {
      previewFeeDeduct: async () => null,
      useFeeDeductBenefit: async () => undefined,
    };
    // 事务后副作用：#16② enqueueOrderCreated 已接真队列（订单创建邮件，worker 消费发信）；
    // 其余三端口仍待 SDK 迁移（翻译 / 商品信息补全 依赖 1688/淘宝 SDK，S34/S35）。
    const sideEffects: PlaceOrderSideEffectPort = {
      enqueueCartToOrderEmail: async () => undefined,
      enqueueOrderCreated: async (input) => {
        const queue = getOrderCreatedQueue();
        if (!queue) return;
        // 收件人邮箱在 web 侧解析（组合根已能取 member），随队携带 → worker 保持无状态、不反向依赖 member 域
        const email = await new MemberRepository().findEmailByUid(input.uid);
        if (!email) return;
        const ids = [...input.orderIds].sort((a, b) => a - b).join(',');
        try {
          await queue.add(
            'order-created',
            { uid: input.uid, orderIds: input.orderIds, totalJpy: input.money.totalMoney, email },
            { jobId: `order-created:${input.uid}:${ids}`, ...DEFAULT_JOB_OPTIONS },
          );
        } catch (e) {
          // 入队失败不阻断已提交的下单：邮件是 best-effort，记日志可补
          console.error(
            '[order] enqueueOrderCreated 入队失败（邮件可能漏发，可补偿）：',
            (e as Error).message,
          );
        }
      },
      enqueueCompletionGoodsInfo: async () => undefined,
      enqueueTranslateOrderGoodsInfo: async () => undefined,
    };
    // 一件代发运单（dg_sendorder 属主 = send-order 域；跨域走 service 接口）
    const sendOrderPort: DaifaSendOrderPort = new SendOrderServiceImpl(
      new SendOrderRepository(),
      {
        listBriefBySids: (sids) => repository.listBriefBySids(repository.db, sids),
        listSidsByShipmentKeyword: (uid, keyword, isDf) =>
          repository.listSidsByShipmentKeyword(repository.db, uid, keyword, isDf),
      },
      { resolve: () => null },
    );
    return new PlaceOrderService({
      repository,
      runTx: runInOrderTransaction,
      supplierCatalog: getSupplierCatalog(),
      goodsPriceRefreshPort,
      skuTranslationPort,
      benefitPort,
      lockPort: createProcessLock(),
      sideEffects,
      sendOrderPort,
      feeDeductPreviewEnabled: process.env.FEE_DEDUCT_PREVIEW_SWITCH != null,
      utypeCharged: Number(process.env.UTYPE_CHARGED ?? 1),
      skuCooldownSeconds: 30, // 旧 SKU_COOLDOWN_SECONDS
      processLockSeconds: 300, // 旧 PROCESS_LOCK_SECONDS
    });
  })();
  return placeOrderService;
}
