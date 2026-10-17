import type { SendOrderRepository } from './repository';

/**
 * 运单/合包/发货/发票 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：Services/SendOrder*；R3 归属：oms
 */
export interface SendOrderService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'send-order';

  /**
   * 1688 物流建档运单（旧 OrderController::tryGetOrders 尾段 1:1）：
   * STATE_WAITING=1 / OTYPE_3=3「一件代发」/ 全零金额字段 / receiver 直落 address+country。
   * 返回新 sid；回写 dg_order.sid 由调用方（order 域编排，属主写自己表）完成。
   */
  createFor1688Logistics(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    oids: number[];
    receiver: { regionName?: string; detailAddress?: string };
  }): Promise<{ sid: number }>;
}

export class SendOrderServiceImpl implements SendOrderService {
  readonly domain = 'send-order' as const;

  constructor(protected readonly repository: SendOrderRepository) {}

  async createFor1688Logistics(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    oids: number[];
    receiver: { regionName?: string; detailAddress?: string };
  }): Promise<{ sid: number }> {
    return this.repository.createFor1688Logistics(input);
  }
}
