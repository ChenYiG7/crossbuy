import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type {
  CooldownStore,
  DistributedLock,
  IdempotencyStore,
  TtlCache,
  WithLockOptions,
  WithLockResult,
} from './types';

/**
 * Redis 连接（锁/冷却专用）。
 *
 * ⚠ 每个参数都有来历，别顺手改：
 * - `enableOfflineQueue: false`：Redis 挂掉时命令**立即报错**，而不是排进离线队列无限期等待。
 *   闸门宁可显式失败（请求被拒 = fail-closed），也不能「请求转了半天其实没锁上」。
 * - `maxRetriesPerRequest: 1`：命令级重试只留一次，避免一次网络抖动把下单请求拖到几十秒。
 * - `lazyConnect: true`：不在构造时连接。代价是**第一个命令前必须自己 connect**（见
 *   `waitForRedis`）——否则会撞 `Stream isn't writeable and enableOfflineQueue options is
 *   false`：**进程启动后的第一笔下单必然失败**。这是本地跑真 Redis 才暴露的坑。
 */
export function createRedis(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3_000,
  });
}

const READY_TIMEOUT_MS = 5_000;
const pending = new WeakMap<Redis, Promise<void>>();

/**
 * 等到连接就绪（幂等：同一 client 并发调用只等同一个 Promise）。
 *
 * 失败即抛 ⇒ 调用方（闸门）按「拿不到锁」处理，请求被拒。这是**刻意**的 fail-closed：
 * 分布式闸门如果连不上 Redis 还放行，等于回到单机 Map 时代的「闸门存在但没用」。
 */
export function waitForRedis(redis: Redis): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();

  const inflight = pending.get(redis);
  if (inflight !== undefined) return inflight;

  const p = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('redis 连接超时：分布式闸门不可用（按抢锁失败处理）')),
      READY_TIMEOUT_MS,
    );
    const settle = (err: Error | null): void => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('error', onError);
      pending.delete(redis);
      if (err) reject(err);
      else resolve();
    };
    const onReady = (): void => settle(null);
    const onError = (e: Error): void => settle(e);
    redis.once('ready', onReady);
    redis.once('error', onError);
    // lazyConnect：没人 connect 就永远等不到 ready；已连上时 connect() 会 reject，吞掉即可
    redis.connect().catch(() => undefined);
  });

  pending.set(redis, p);
  return p;
}

/**
 * 释放脚本：**必须**做 token 比对。
 *
 * 反例（不加比对会出的事故）：进程 A 持锁但临界区超过 ttl → 锁自动过期 → 进程 B 抢到 →
 * A 结束后来 `DEL` → 删掉的是 B 的锁 → 进程 C 立刻也能进来 ⇒ 互斥彻底失效，
 * 而日志里一切都「正常」。这是分布式锁最经典的坑，比对一次 GET 就能堵死。
 */
const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** Redis 分布式锁（SET key token NX PX ttl + token 比对释放） */
export function createRedisLock(redis: Redis): DistributedLock {
  const acquire = async (key: string, ttlMs: number): Promise<string | null> => {
    await waitForRedis(redis);
    // NX = 只在不存在时设（抢占）；PX = 毫秒级自动过期（崩溃兜底）
    const ok = await redis.set(key, randomUUID(), 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    // SET 的返回值不带 value，回读一次拿到释放所需的 token
    return await redis.get(key);
  };

  const release = async (key: string, token: string): Promise<boolean> => {
    await waitForRedis(redis);
    return Number(await redis.eval(RELEASE_LUA, 1, key, token)) === 1;
  };

  return {
    acquire,
    release,
    async withLock<T>(
      key: string,
      opts: WithLockOptions,
      fn: () => Promise<T>,
    ): Promise<WithLockResult<T>> {
      const deadline = Date.now() + opts.waitMs;
      const pollMs = opts.pollMs ?? 50;
      const token = await (async (): Promise<string | null> => {
        for (;;) {
          const t = await acquire(key, opts.ttlMs);
          if (t !== null) return t;
          if (Date.now() >= deadline) return null;
          await new Promise((r) => setTimeout(r, pollMs));
        }
      })();
      if (token === null) return { acquired: false };
      try {
        return { acquired: true, value: await fn() };
      } finally {
        await release(key, token);
      }
    },
  };
}

/** Redis 冷却窗口（EXISTS / SET PX） */
export function createRedisCooldown(redis: Redis): CooldownStore {
  return {
    async has(key) {
      await waitForRedis(redis);
      return (await redis.exists(key)) === 1;
    },
    async put(key, ttlMs) {
      await waitForRedis(redis);
      await redis.set(key, '1', 'PX', ttlMs);
    },
  };
}

/** Redis 幂等标记（SET key 1 NX PX 抢占） */
export function createRedisIdempotency(redis: Redis): IdempotencyStore {
  return {
    async claim(key, ttlMs) {
      await waitForRedis(redis);
      // NX = 只在未占用时落标记；PX = 毫秒级兜底过期
      return (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK';
    },
    async has(key) {
      await waitForRedis(redis);
      return (await redis.exists(key)) === 1;
    },
    async forget(key) {
      await waitForRedis(redis);
      await redis.del(key);
    },
  };
}

/** Redis TTL 缓存（GET / SET PX / DEL；旧 Laravel Cache 三件套的等价面） */
export function createRedisTtlCache(redis: Redis): TtlCache {
  return {
    async get(key) {
      await waitForRedis(redis);
      return await redis.get(key);
    },
    async put(key, value, ttlMs) {
      await waitForRedis(redis);
      await redis.set(key, value, 'PX', ttlMs);
    },
    async forget(key) {
      await waitForRedis(redis);
      await redis.del(key);
    },
  };
}
