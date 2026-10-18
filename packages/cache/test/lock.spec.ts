import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryCooldown,
  createInMemoryLock,
  createRedis,
  createRedisCooldown,
  createRedisLock,
  waitForRedis,
} from '../src';
import type { CooldownStore, DistributedLock } from '../src';

/**
 * 锁/冷却测试。
 *
 * 纪律（记忆坑②「跑绿 ≠ 守卫有效」）：每条**守卫**断言都要配一次「主动破坏」——
 * 不是证明「正常流程能过」，而是证明「异常流程被拦住」。本文件的
 * 「错 token 不能释放」「TTL 到期后可重抢」「waitMs 超时放弃」三条就是破坏用例。
 *
 * 同一组断言在 **Redis / 内存** 两种实现上各跑一遍：内存实现是生产回退路径，
 * 语义必须与 Redis 一致，否则回退一旦触发就是「闸门还在、闸门没用」。
 */

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
let redis = createRedis(REDIS_URL);

beforeAll(async () => {
  // 连不上就别硬跑（否则每条用例都超时，看着像「测试卡住」而不是「Redis 没起」）
  await waitForRedis(redis);
});

afterAll(async () => {
  await redis.quit();
});

/** 用例之间互不干扰：key 带随机前缀（不 flushdb——本机 Redis 可能被别的服务共用） */
const key = (tag: string): string => `test:lock:${tag}:${randomUUID()}`;

const impls: Array<{ name: string; lock: () => DistributedLock; cooldown: () => CooldownStore }> = [
  {
    name: 'redis',
    lock: () => createRedisLock(redis),
    cooldown: () => createRedisCooldown(redis),
  },
  { name: 'in-memory', lock: () => createInMemoryLock(), cooldown: () => createInMemoryCooldown() },
];

describe.each(impls)('DistributedLock（$name）', ({ lock }) => {
  it('抢占：第一次拿到 token，第二次被占用返回 null', async () => {
    const l = lock();
    const k = key('acquire');
    const first = await l.acquire(k, 5_000);
    expect(first).toBeTruthy();
    expect(await l.acquire(k, 5_000)).toBeNull();
    await l.release(k, first as string);
  });

  it('★ 守卫：错 token 释放不掉（否则超时后旧持锁者会删掉新持锁者的锁）', async () => {
    const l = lock();
    const k = key('wrong-token');
    const token = (await l.acquire(k, 5_000)) as string;

    // 主动破坏：拿别人的 token 去释放
    expect(await l.release(k, 'someone-elses-token')).toBe(false);
    // 锁必须还在（这是本用例真正的断言，不是上面那行）
    expect(await l.acquire(k, 5_000)).toBeNull();

    await l.release(k, token);
  });

  it('正确 token 释放后可重抢', async () => {
    const l = lock();
    const k = key('release');
    const token = (await l.acquire(k, 5_000)) as string;
    expect(await l.release(k, token)).toBe(true);
    expect(await l.acquire(k, 5_000)).toBeTruthy();
  });

  it('★ 崩溃兜底：ttl 到期后锁自动释放（持锁进程挂了不会永久死锁）', async () => {
    const l = lock();
    const k = key('ttl');
    expect(await l.acquire(k, 200)).toBeTruthy();
    expect(await l.acquire(k, 200)).toBeNull();
    await new Promise((r) => setTimeout(r, 350));
    expect(await l.acquire(k, 200)).toBeTruthy();
  });

  it('withLock 互斥：持锁期间另一方抢不到', async () => {
    const l = lock();
    const k = key('withlock');
    const order: string[] = [];
    const [a, b] = await Promise.all([
      l.withLock(k, { ttlMs: 2_000, waitMs: 0, pollMs: 20 }, async () => {
        order.push('A-in');
        await new Promise((r) => setTimeout(r, 150));
        order.push('A-out');
        return 'A';
      }),
      l.withLock(k, { ttlMs: 2_000, waitMs: 0, pollMs: 20 }, async () => {
        order.push('B-in');
        return 'B';
      }),
    ]);
    const aOk = a.acquired;
    const bOk = b.acquired;
    expect(aOk || bOk).toBe(true);
    // 「抢不到」的那一方不许进入临界区
    if (!bOk) expect(order).not.toContain('B-in');
    if (!aOk) expect(order).not.toContain('A-in');
  });

  it('★ 守卫：waitMs 超时后放弃（不无限等）', async () => {
    const l = lock();
    const k = key('timeout');
    const token = (await l.acquire(k, 5_000)) as string;
    const started = Date.now();
    const r = await l.withLock(k, { ttlMs: 1_000, waitMs: 120, pollMs: 20 }, async () => 'never');
    expect(r.acquired).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    await l.release(k, token);
  });

  it('withLock 正常路径返回值并释放锁', async () => {
    const l = lock();
    const k = key('withlock-ok');
    const r = await l.withLock(k, { ttlMs: 2_000, waitMs: 100, pollMs: 20 }, async () => 42);
    expect(r).toEqual({ acquired: true, value: 42 });
    // 结束时锁已释放 ⇒ 立刻能再抢
    expect(await l.acquire(k, 2_000)).toBeTruthy();
  });
});

describe.each(impls)('CooldownStore（$name）', ({ cooldown }) => {
  it('put 后 has 为真；到期后为假', async () => {
    const c = cooldown();
    const k = key('cooldown');
    expect(await c.has(k)).toBe(false);
    await c.put(k, 200);
    expect(await c.has(k)).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    expect(await c.has(k)).toBe(false);
  });
});

describe('Redis 实现专属：跨连接互斥', () => {
  /**
   * 内存实现**跑不了**这条（这正是 TODO(#16) 的根因）：两条独立连接 = 两个进程，
   * 只有 Redis 实现能让它们互斥。这条用例是「闸门真的分布式的」唯一证据。
   */
  it('两条独立 Redis 连接抢占同一把锁，只有一个能成功', async () => {
    const other = createRedis(REDIS_URL);
    try {
      const l1 = createRedisLock(redis);
      const l2 = createRedisLock(other);
      const k = key('cross-conn');
      const t1 = await l1.acquire(k, 5_000);
      expect(t1).toBeTruthy();
      expect(await l2.acquire(k, 5_000)).toBeNull();
      await l1.release(k, t1 as string);
      expect(await l2.acquire(k, 5_000)).toBeTruthy();
    } finally {
      await other.quit();
    }
  });
});
