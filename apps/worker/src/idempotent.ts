import type { IdempotencyStore } from '@crossbuy/cache';

/**
 * 幂等执行模板（队列消费护栏）。
 *
 * 为什么需要它：BullMQ 的 `jobId` 只能拦「同一 jobId 重复入队」，拦不住「重试 / 上游重放 /
 * 跨连接」带来的不同 jobId 但代表同一件事。所以在处理体之前先 `claim` 一个跨进程幂等标记：
 * - 抢到 = 第一次处理，执行 `fn`；
 * - 抢不到 = 已经处理过，`onAlreadyDone` 兜底（默认什么都不做，直接收工 = 不重试、不重复副作用）。
 *
 * ⚠ `fn` 内部若执行失败需要重试，**必须自己先 `idempotency.forget(key)` 再抛错**——否则标记还在，
 * BullMQ 重试时会判「已处理」直接跳过，副作用（如发邮件）就永久丢失了。见 `jobs/order-created.ts`。
 */
export async function runIdempotent(
  idempotency: IdempotencyStore,
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
  onAlreadyDone: () => void = () => undefined,
): Promise<void> {
  const claimed = await idempotency.claim(key, ttlMs);
  if (!claimed) {
    onAlreadyDone();
    return;
  }
  await fn();
}
