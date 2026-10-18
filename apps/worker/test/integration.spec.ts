import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { createConnection, DEFAULT_JOB_OPTIONS, QUEUES } from '@crossbuy/jobs';
import {
  createRedis,
  createRedisIdempotency,
  waitForRedis,
  type Redis,
} from '@crossbuy/cache';
import type { NotifyChannel, Notification } from '@crossbuy/notify';
import { processOrderCreated, type OrderCreatedJobData } from '../src/jobs/order-created';

/**
 * 集成测试：完整 入队 → worker 消费 → 发信 链路，连**真实 Redis + 真实 BullMQ**。
 *
 * Redis 不可达时整体 skip（不硬失败，否则 CI 无 Redis 会红；本地开发 Redis 已起时正常跑）。
 * 这里验证的是「web 入队（同 QUEUES / 同 connection）— worker 消费」两端契约一致，
 * 单测覆盖不到这一层。
 */
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
let redis: Redis | null = null;
let redisUp = false;

beforeAll(async () => {
  try {
    redis = createRedis(REDIS_URL);
    await waitForRedis(redis);
    redisUp = true;
  } catch {
    redisUp = false;
  }
});

afterAll(async () => {
  if (redis) await redis.quit();
});

function fakeNotify() {
  const sent: Notification[] = [];
  const channel: NotifyChannel = {
    kind: 'email',
    async send(n) {
      sent.push(n);
      return { ok: true };
    },
  };
  return { channel, sent };
}

function waitForJob(worker: Worker, jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onCompleted = (j: { id?: string }): void => {
      if (j.id === jobId) finish();
    };
    const onFailed = (j: { id?: string } | undefined, err: Error): void => {
      if (j?.id === jobId) {
        worker.off('completed', onCompleted);
        worker.off('failed', onFailed);
        reject(err);
      }
    };
    const finish = (): void => {
      worker.off('completed', onCompleted);
      worker.off('failed', onFailed);
      resolve();
    };
    worker.on('completed', onCompleted);
    worker.on('failed', onFailed);
  });
}

describe('order-created 集成（真实 BullMQ + Redis）', () => {
  it('入队 → worker 消费 → 邮件送达，且幂等标记防重', async () => {
    if (!redisUp || !redis) {
      console.warn('[integration] Redis 不可达，跳过 order-created 集成测试');
      return;
    }
    const { channel, sent } = fakeNotify();
    const idem = createRedisIdempotency(redis);
    const queue = new Queue<OrderCreatedJobData>(QUEUES.orderCreated, {
      connection: createConnection(REDIS_URL),
    });
    const worker = new Worker<OrderCreatedJobData>(
      QUEUES.orderCreated,
      (job) => processOrderCreated(job.data, { notify: channel, idempotency: idem }),
      { connection: createConnection(REDIS_URL) },
    );
    try {
      const jobId = `it-${randomUUID()}`;
      const job = await queue.add(
        'order-created',
        { uid: 7, orderIds: [11, 12], totalJpy: 9000, email: 'u7@x.com' },
        { jobId, ...DEFAULT_JOB_OPTIONS },
      );
      await waitForJob(worker, job.id!);

      expect(sent).toHaveLength(1);
      expect(sent[0].target).toBe('u7@x.com');
      expect(sent[0].title).toContain('订单已提交');

      // 同一 jobId 再入队一次（模拟上游重放）→ 因幂等标记仍在，不再发信
      const dupId = `it-dup-${randomUUID()}`;
      // 用不同 jobId 但相同业务键，验证跨 jobId 幂等（BullMQ 只拦同 jobId）
      await queue.add(
        'order-created',
        { uid: 7, orderIds: [12, 11], totalJpy: 9000, email: 'u7@x.com' },
        { jobId: dupId, ...DEFAULT_JOB_OPTIONS },
      );
      await waitForJob(worker, dupId);
      expect(sent).toHaveLength(1);
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 30_000);
});
