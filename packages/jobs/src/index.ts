import type { ConnectionOptions, JobsOptions } from 'bullmq';

/**
 * 队列名注册表：一个业务域一个队列，命名与 contract / 域事件对齐。
 *
 * web（入队）与 worker（消费）共享同一份，避免两边字符串漂移——
 * 之前 worker 自己定义 `QUEUES`、web 侧用裸字符串，迟早会拼错且零类型保护。
 */
export const QUEUES = {
  /** 冒烟 / 连通性探针（部署健康检查用，保留） */
  ping: 'ping',
  /** 下单成功邮件（#16② `enqueueOrderCreated` → 真实 Job） */
  orderCreated: 'order.created',
  /** 加购后商品信息补全（#16② `enqueueCompletionGoodsInfoForCart`，R1 未接线，预留） */
  completionGoodsInfo: 'completion.goods-info',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** BullMQ 连接（只认 REDIS_URL；密码/TLS 走 URL 本身） */
export function createConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl };
}

/**
 * 默认 job 选项：失败指数退避重试，完成后保留 1000 条 / 失败保留 5000 条便于排查
 * （BullMQ 默认 `removeOnComplete: true` —— 一旦消费成功就删，事故后无迹可查）。
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};
