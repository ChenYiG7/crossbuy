import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryIdempotency,
  createRedis,
  createRedisIdempotency,
  waitForRedis,
} from '../src';
import type { IdempotencyStore } from '../src';

/**
 * 幂等标记测试。同一组断言在 **Redis / 内存** 两种实现上各跑一遍：内存实现是生产回退路径，
 * 语义必须与 Redis 一致（否则回退一旦触发，幂等护栏形同虚设）。
 *
 * ★ 守卫用例（记忆坑②「跑绿 ≠ 守卫有效」）：本文件「已被占用时 claim 返回 false」「TTL
 * 到期后可重 claim」两条就是主动破坏——证明重复事件真的被拦下，而不是「处理成功就绿了」。
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
let redis = createRedis(REDIS_URL);

beforeAll(async () => {
  await waitForRedis(redis);
});

afterAll(async () => {
  await redis.quit();
});

/** 用例之间互不干扰：key 带随机前缀（不 flushdb——本机 Redis 可能被别的服务共用） */
const key = (tag: string): string => `test:idem:${tag}:${randomUUID()}`;

const impls: Array<{ name: string; make: () => IdempotencyStore }> = [
  { name: 'redis', make: () => createRedisIdempotency(redis) },
  { name: 'in-memory', make: () => createInMemoryIdempotency() },
];

describe.each(impls)('IdempotencyStore（$name）', ({ make }) => {
  it('claim 第一次成功、第二次（未过期）被拦为 false', async () => {
    const s = make();
    const k = key('first');
    expect(await s.claim(k, 5_000)).toBe(true);
    expect(await s.claim(k, 5_000)).toBe(false);
    expect(await s.has(k)).toBe(true);
  });

  it('★ 守卫：TTL 到期后标记失效、可重新 claim', async () => {
    const s = make();
    const k = key('ttl');
    expect(await s.claim(k, 200)).toBe(true);
    expect(await s.claim(k, 200)).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect(await s.claim(k, 200)).toBe(true);
  });

  it('forget 主动清除后可再次 claim', async () => {
    const s = make();
    const k = key('forget');
    expect(await s.claim(k, 30_000)).toBe(true);
    await s.forget(k);
    expect(await s.has(k)).toBe(false);
    expect(await s.claim(k, 30_000)).toBe(true);
  });
});

describe('Redis 实现专属：跨连接去重', () => {
  /**
   * 内存实现**跑不了**这条（这正是幂等护栏在单实例下测不出的盲区）：两条独立连接 = 两个
   * 进程，只有 Redis 实现能让「同一件事在两个进程里都不重复处理」。这条是「幂等真的跨进程」的
   * 唯一证据。
   */
  it('两条独立 Redis 连接对同 key 只有一个能 claim 成功', async () => {
    const other = createRedis(REDIS_URL);
    try {
      const s1 = createRedisIdempotency(redis);
      const s2 = createRedisIdempotency(other);
      const k = key('cross-conn');
      expect(await s1.claim(k, 5_000)).toBe(true);
      expect(await s2.claim(k, 5_000)).toBe(false);
      await s1.forget(k);
      expect(await s2.claim(k, 5_000)).toBe(true);
    } finally {
      await other.quit();
    }
  });
});
