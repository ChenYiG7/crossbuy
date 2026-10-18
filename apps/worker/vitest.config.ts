import { defineConfig } from 'vitest/config';

/**
 * worker 测试配置。
 *
 * - 单元/逻辑用例用**内存**幂等 + fake `NotifyChannel`，不依赖 Redis，每次跑都过。
 * - 集成用例（`test/integration.spec.ts`）连**真实 Redis** 走完整 入队 → 消费 → 发信 链路，
 *   Redis 连不上时整体 skip（与 @crossbuy/cache 同口径：连不上别硬跑，否则看着像卡死）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379',
    },
  },
});
