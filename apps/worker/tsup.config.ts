import { defineConfig } from 'tsup';

/** 纯 Node 服务（BullMQ worker）的打包配置，理由同 apps/api/tsup.config.ts。 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  noExternal: ['@crossbuy/config'],
  sourcemap: true,
});
