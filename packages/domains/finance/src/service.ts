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

  /**
   * CNY→JPY 汇率（旧 Currency::convert(...)->get() 1:1）：
   * 3 分钟进程内缓存 → dg_huilv 当天当前小时 → 未命中落最新一条（外部 MUFG/Yahoo API
   * 分支 R1 不迁移，S31）→ 全空 = 0。
   */
  getCnyToJpyRate(now?: Date): Promise<number>;
}

export class FinanceServiceImpl implements FinanceService {
  readonly domain = 'finance' as const;

  /** 旧 Cache::remember 3 分钟（进程内；多实例部署换 Redis——端口化随基建） */
  private cache: { value: number; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 3 * 60 * 1000;

  constructor(protected readonly repository: FinanceRepository) {}

  async getCnyToJpyRate(now: Date = new Date()): Promise<number> {
    if (this.cache && this.cache.expiresAt > now.getTime()) {
      return this.cache.value;
    }
    const hourly = await this.repository.findRateByHour(now);
    let rate: number;
    if (hourly !== null && hourly !== 0) {
      rate = hourly;
    } else {
      // 旧：外部 API（三菱 +0.5 点 / Yahoo +0.8 点）→ R1 不迁移，直接落最新一条 → 0
      rate = (await this.repository.findLatestRate()) ?? 0;
    }
    this.cache = { value: rate, expiresAt: now.getTime() + FinanceServiceImpl.CACHE_TTL_MS };
    return rate;
  }
}
