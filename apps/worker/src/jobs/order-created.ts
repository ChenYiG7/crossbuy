import { buildOrderCreatedEmail, type NotifyChannel } from '@crossbuy/notify';
import type { IdempotencyStore } from '@crossbuy/cache';
import { runIdempotent } from '../idempotent';

/**
 * 下单成功邮件 Job 的入参（web 入队时塞好；worker 不再查 member 域，保持无状态）。
 *
 * 与 `PlaceOrderSideEffectPort.enqueueOrderCreated` 的输入对齐，但多了 `email`——
 * 邮箱在 web 侧（组合根已能取 member）解析好随队携带，避免 worker 反向依赖 member 域。
 */
export interface OrderCreatedJobData {
  readonly uid: number;
  readonly orderIds: number[];
  /** 订单总金额（日元，已按旧 `countMoney` 口径算好） */
  readonly totalJpy: number;
  /** 收件人邮箱（web 入队前解析） */
  readonly email: string;
}

export interface OrderCreatedDeps {
  readonly notify: NotifyChannel;
  readonly idempotency: IdempotencyStore;
}

/** 幂等标记 TTL：同 uid+orderIds 30 天内不重复发邮件（远大于「可能重复到达」的窗口） */
export const ORDER_CREATED_IDEMPOTENCY_TTL_MS = 30 * 24 * 3600 * 1000;

export function idempotencyKeyForOrderCreated(data: OrderCreatedJobData): string {
  const ids = [...data.orderIds].sort((a, b) => a - b).join(',');
  return `order-created:${data.uid}:${ids}`;
}

/**
 * 下单成功邮件处理器（#16② `enqueueOrderCreated` 的真实落点）。
 *
 * 旧 `ProcessCreateEmail`（MAIL_TYPE_CART_TO_ORDER）在事务内 `dispatch`，新架构改为
 * AFTER_COMMIT 后入队、worker 消费、AFTER_COMMIT 语义（docs/07 铁律 7：事务内禁外呼）。
 *
 * 失败处理：邮件渠道返回非 ok → **先 forget 标记再抛错**，让 BullMQ 按 backoff 重试
 * （否则标记还在会被判「已处理」跳过，邮件永久丢失）。幂等护栏只在「成功」时生效——
 * 这正是 `runIdempotent` 里「fn 失败需自己 forget」约定的来由。
 */
export async function processOrderCreated(
  data: OrderCreatedJobData,
  deps: OrderCreatedDeps,
): Promise<void> {
  if (!data.email) {
    // 无邮箱不是错误，是「这条通知没法定投」→ 收工、不重试（重试也还是没邮箱）
    return;
  }
  const key = idempotencyKeyForOrderCreated(data);
  await runIdempotent(
    deps.idempotency,
    key,
    ORDER_CREATED_IDEMPOTENCY_TTL_MS,
    async () => {
      const result = await deps.notify.send(
        buildOrderCreatedEmail({
          uid: data.uid,
          orderIds: data.orderIds,
          totalJpy: data.totalJpy,
          email: data.email,
        }),
      );
      if (!result.ok) {
        // 让 runIdempotent 的「已处理」判定失效，BullMQ 才能重试
        await deps.idempotency.forget(key);
        throw new Error(`order-created 邮件发送失败：${result.code} ${result.message}`);
      }
    },
  );
}
