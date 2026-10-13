import type { ConnectionOptions } from 'bullmq';

/**
 * 队列名注册表：一个业务域一个队列，命名与 contract 约定对齐。
 * 后续按迁移顺序补：order-sync / send-order / webhook / reconcile / logistics ...
 */
export const QUEUES = {
  /** 冒烟队列（演示用，接入真实 Job 后可删） */
  ping: 'ping',
} as const;

export function createConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl };
}
