import type { Notification } from './channel';

/**
 * 订单创建成功邮件（旧 `ProcessCreateEmail` MAIL_TYPE_CART_TO_ORDER 的 R1 复现）。
 *
 * 旧系统该 Job 在事务内 `dispatch`，新架构改为 AFTER_COMMIT 后由 worker 消费并发——本函数
 * 只负责「把下单结果渲染成一封邮件」，不碰任何渠道细节（渠道由 `NotifyChannel` 决定）。
 */
export interface OrderCreatedEmailInput {
  readonly uid: number;
  readonly orderIds: number[];
  /** 订单总金额（日元，已按旧 `countMoney` 口径算好） */
  readonly totalJpy: number;
  /** 收件人邮箱（web 入队前解析，worker 不再查 member 域） */
  readonly email: string;
}

export function buildOrderCreatedEmail(input: OrderCreatedEmailInput): Notification {
  const orderList = input.orderIds.join('、');
  const total = input.totalJpy.toLocaleString('ja-JP');
  return {
    channel: 'email',
    target: input.email,
    title: `【淘太郎】您的订单已提交（共 ${input.orderIds.length} 笔）`,
    body: [
      `尊敬的会员（ID: ${input.uid}）：`,
      '',
      `您的代购订单已成功提交，订单号：${orderList}。`,
      `订单总金额：¥${total}（日元）。`,
      '',
      '我们将尽快为您采购并同步物流信息，可在「我的订单」中查看实时进度。',
      '',
      '—— 淘太郎代购',
    ].join('\n'),
  };
}
