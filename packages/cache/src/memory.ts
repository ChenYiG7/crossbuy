import { randomUUID } from 'node:crypto';
import type { CooldownStore, DistributedLock, IdempotencyStore, WithLockOptions, WithLockResult } from './types';

/**
 * 进程内实现（**单实例正确，多实例无效**）。
 *
 * 用途：① 本地开发/单测不依赖 Redis 也能跑；② 组合根在无 REDIS_URL 时的显式回退。
 * ⚠ 生产多实例部署**不得**走这条路——接口与 Redis 实现一致，但互斥范围只有本进程，
 *   这正是 TODO(#16) 要修掉的东西。回退发生时组合根要打 WARNING 日志，别静默。
 */
export function createInMemoryLock(): DistributedLock {
  /** key → { token, expiresAt } */
  const held = new Map<string, { token: string; expiresAt: number }>();

  const sweep = (key: string): void => {
    const cur = held.get(key);
    if (cur !== undefined && cur.expiresAt <= Date.now()) held.delete(key);
  };

  return {
    async acquire(key, ttlMs) {
      sweep(key);
      if (held.has(key)) return null;
      const token = randomUUID();
      held.set(key, { token, expiresAt: Date.now() + ttlMs });
      return token;
    },
    async release(key, token) {
      const cur = held.get(key);
      if (cur === undefined) return false;
      // token 比对：过期的锁已被别人抢走时，旧持锁者不能删新锁
      if (cur.token !== token) return false;
      held.delete(key);
      return true;
    },
    async withLock<T>(
      key: string,
      opts: WithLockOptions,
      fn: () => Promise<T>,
    ): Promise<WithLockResult<T>> {
      const deadline = Date.now() + opts.waitMs;
      const pollMs = opts.pollMs ?? 50;
      let token: string | null = null;
      for (;;) {
        sweep(key);
        if (!held.has(key)) {
          token = randomUUID();
          held.set(key, { token, expiresAt: Date.now() + opts.ttlMs });
          break;
        }
        if (Date.now() >= deadline) return { acquired: false };
        await new Promise((r) => setTimeout(r, pollMs));
      }
      try {
        return { acquired: true, value: await fn() };
      } finally {
        const cur = held.get(key);
        if (cur !== undefined && cur.token === token) held.delete(key);
      }
    },
  };
}

export function createInMemoryCooldown(): CooldownStore {
  const until = new Map<string, number>();
  return {
    async has(key) {
      const expiry = until.get(key);
      if (expiry === undefined) return false;
      if (expiry <= Date.now()) {
        until.delete(key);
        return false;
      }
      return true;
    },
    async put(key, ttlMs) {
      until.set(key, Date.now() + ttlMs);
    },
  };
}

export function createInMemoryIdempotency(): IdempotencyStore {
  const until = new Map<string, number>();
  const sweep = (key: string): void => {
    const expiry = until.get(key);
    if (expiry !== undefined && expiry <= Date.now()) until.delete(key);
  };
  return {
    async claim(key, ttlMs) {
      sweep(key);
      if (until.has(key)) return false;
      until.set(key, Date.now() + ttlMs);
      return true;
    },
    async has(key) {
      sweep(key);
      return until.has(key);
    },
    async forget(key) {
      until.delete(key);
    },
  };
}
