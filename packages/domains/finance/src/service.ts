import type { FinanceRepository } from './repository';

/**
 * 余额写/充值/支付/汇率 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：Services/Finance；R3 归属：财务系统（R3 落账本/对账）
 */
export interface FinanceService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'finance';
}

export class FinanceServiceImpl implements FinanceService {
  readonly domain = 'finance' as const;

  constructor(protected readonly repository: FinanceRepository) {}
}
