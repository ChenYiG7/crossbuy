import { defineConfig } from 'vitest/config';

/**
 * cache 包测试配置。
 *
 * 连**真实 Redis** 跑（与 member 域「连真实 MySQL」同一口径：R1 复现期的风险恰恰在
 * 真实中间件语义与本地假实现的错位上——进程内 Map 永远测不出跨实例互斥）。
 *
 * 数据源：TEST_REDIS_URL，缺省回落到本机 FlyEnv Redis `127.0.0.1:6379`
 * （启动：`D:/Program Files/FlyEnv-Data/app/redis-8.10.2/Redis-8.10.2-Windows-x64-msys2/redis-server.exe redis.conf`）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    fileParallelism: false,
    // 锁的 TTL 用例依赖真实等待；Redis 往返本身很快，10s 足够宽
    testTimeout: 10_000,
    env: {
      TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    },
  },
});
