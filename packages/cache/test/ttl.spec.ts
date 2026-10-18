import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryTtlCache, createRedis, createRedisTtlCache, waitForRedis } from '../src';
import type { TtlCache } from '../src';

/**
 * TTL 缓存测试。同一组断言在 **Redis / 内存** 两种实现上各跑一遍：内存实现是生产回退路径
 * （无 REDIS_URL 时），语义必须与 Redis 一致（否则回退触发时缓存时灵时不灵）。
 *
 * ★ 守卫用例（「跑绿 ≠ 守卫有效」）：「TTL 到期后 get 返回 null」是主动破坏——证明过期
 * 真的失效，而不是任何 put 都能永久取回。
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
const key = (tag: string): string => `test:ttl:${tag}:${randomUUID()}`;

const impls: Array<{ name: string; make: () => TtlCache }> = [
  { name: 'redis', make: () => createRedisTtlCache(redis) },
  { name: 'in-memory', make: () => createInMemoryTtlCache() },
];

describe.each(impls)('TtlCache（$name）', ({ make }) => {
  it('put 后 get 取回原值（字符串原样，不做序列化）；forget 后取空', async () => {
    const c = make();
    const k = key('put-get');
    expect(await c.get(k)).toBeNull();
    await c.put(k, '{"raw":"body"}', 5_000);
    expect(await c.get(k)).toBe('{"raw":"body"}');
    await c.forget(k);
    expect(await c.get(k)).toBeNull();
  });

  it('★ 守卫：TTL 到期后 get 返回 null（不是过期残留值）', async () => {
    const c = make();
    const k = key('ttl');
    await c.put(k, 'v', 200);
    expect(await c.get(k)).toBe('v');
    await new Promise((r) => setTimeout(r, 350));
    expect(await c.get(k)).toBeNull();
  });

  it('同 key 后写覆盖旧值', async () => {
    const c = make();
    const k = key('overwrite');
    await c.put(k, 'v1', 5_000);
    await c.put(k, 'v2', 5_000);
    expect(await c.get(k)).toBe('v2');
  });
});

describe('Redis 实现专属：跨连接共享', () => {
  /**
   * 内存实现跑不了这条——「实例间共享缓存」只有 Redis 实现能给证据（多实例部署的命中率
   * 依赖这一点；fenxiao 详情缓存的生产形态就是它）。
   */
  it('另一条连接 put 的值，本连接 get 得到', async () => {
    const other = createRedis(REDIS_URL);
    try {
      const c1 = createRedisTtlCache(redis);
      const c2 = createRedisTtlCache(other);
      const k = key('cross-conn');
      await c2.put(k, 'from-other', 5_000);
      expect(await c1.get(k)).toBe('from-other');
    } finally {
      await other.quit();
    }
  });
});
