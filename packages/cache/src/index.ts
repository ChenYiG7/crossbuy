export type {
  AcquireResult,
  CooldownStore,
  DistributedLock,
  WithLockOptions,
  WithLockResult,
} from './types';
export { createInMemoryCooldown, createInMemoryLock } from './memory';
export { createRedis, createRedisCooldown, createRedisLock, waitForRedis } from './redis';
export type { Redis } from 'ioredis';
