import { defineConfig } from 'vitest/config';

/**
 * jobs 包测试配置。
 *
 * 默认不依赖中间件（纯函数 / 队列名注册表测试）；未来若加真 BullMQ 集成测试，
 * 参照 @crossbuy/cache 的「连真实 Redis、连不上就 skip」口径。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
