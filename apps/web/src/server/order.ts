import {
  CartService,
  OrderRepository,
  OrderServiceImpl,
  runInOrderTransaction,
  type BenefitPort,
  type CartService as CartServiceType,
  type CurrencyPort,
  type MemberFactorsPort,
  type OrderService,
} from '@crossbuy/domain-order';
import { FinanceServiceImpl, FinanceRepository } from '@crossbuy/domain-finance';
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
