import {
  CartService,
  OrderRepository,
  OrderServiceImpl,
  PlaceOrderService,
  runInOrderTransaction,
  type BenefitPort,
  type CartService as CartServiceType,
  type CurrencyPort,
  type DaifaSendOrderPort,
  type GoodsPriceRefreshPort,
  type MemberFactorsPort,
  type OrderService,
  type PlaceOrderBenefitPort,
  type PlaceOrderSideEffectPort,
  type ProcessLockPort,
  type SkuTranslationPort,
} from '@crossbuy/domain-order';
import { FinanceServiceImpl, FinanceRepository } from '@crossbuy/domain-finance';
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
// cart 读路径组合根（dg_cart/v2_supplier_product 属主 = order 域；跨域端口在此接线）
// ---------------------------------------------------------------------------

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
      // 旧 config('benefit.fee_deduct_preview_switch') !== null
      feeDeductPreviewEnabled: process.env.FEE_DEDUCT_PREVIEW_SWITCH != null,
      // 旧 User::UTYPE_CHARGED（付费会员）
      utypeCharged: Number(process.env.UTYPE_CHARGED ?? 1),
    });
  })();
  return cartService;
}

// ---------------------------------------------------------------------------
// 下单链路组合根（旧 CreateOrderMutation + CreateOrderFromCartService）
// ---------------------------------------------------------------------------

/**
 * 进程内重复下单闸门（旧 Cache::has/put/lock 的 R1 实现）。
 *
 * ⚠ 单实例正确，**多实例部署前必须换成 Redis 实现**（TODO(#16)）——否则冷却/进程锁
 * 只在各自进程内生效。接口与域解耦，换实现只改本文件。
 */
function createInMemoryProcessLock(): ProcessLockPort {
  const cooldowns = new Map<string, number>();
  const locks = new Map<string, number>();
  return {
    async has(key) {
      const until = cooldowns.get(key);
      if (until === undefined) return false;
      if (until <= Date.now()) {
        cooldowns.delete(key);
        return false;
      }
      return true;
    },
    async put(key, ttlSeconds) {
      cooldowns.set(key, Date.now() + ttlSeconds * 1000);
    },
    async acquire(key, ttlSeconds) {
      const until = locks.get(key);
      if (until !== undefined && until > Date.now()) return false;
      locks.set(key, Date.now() + ttlSeconds * 1000);
      return true;
    },
    async release(key) {
      locks.delete(key);
    },
  };
}

let placeOrderService: PlaceOrderService | null = null;

export function getPlaceOrderService(): PlaceOrderService {
  placeOrderService ??= (() => {
    const repository = new OrderRepository();
    // 实时价刷新：R1 SDK（淘宝/1688 商品详情）未迁移 → no-op（S34 登记）
    const goodsPriceRefreshPort: GoodsPriceRefreshPort = { refresh: async () => undefined };
    // 规格翻译：R1 SDK 未迁移 → 恒 null（= 旧「获取失败」分支，跳过归一化不阻断下单）
    const skuTranslationPort: SkuTranslationPort = { attributesFor: async () => null };
    // 权益：benefit 域 R1 未迁移 → 恒 null / no-op（S35 登记）
    const benefitPort: PlaceOrderBenefitPort = {
      previewFeeDeduct: async () => null,
      useFeeDeductBenefit: async () => undefined,
    };
    // 事务后副作用：队列/邮件/MNS 未接线 → no-op（TODO(#16)：随 M0.7 worker 真 Job 落地）
    const sideEffects: PlaceOrderSideEffectPort = {
      enqueueCartToOrderEmail: async () => undefined,
      enqueueOrderCreated: async () => undefined,
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
      goodsPriceRefreshPort,
      skuTranslationPort,
      benefitPort,
      lockPort: createInMemoryProcessLock(),
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
