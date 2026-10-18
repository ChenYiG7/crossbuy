import { defineConfig } from 'tsup';

/** 纯 Node 服务（BullMQ worker）的打包配置，理由同 apps/api/tsup.config.ts。 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  // 内部包走 src/index.ts（M0 决策），tsc 产物里 bare import 解析不了 TS 源 ⇒ 打进 bundle。
  // 外部依赖（bullmq/ioredis/pino…）保持 external 走 node_modules。
  noExternal: ['@crossbuy/config', '@crossbuy/jobs', '@crossbuy/cache', '@crossbuy/notify'],
  sourcemap: true,
});
