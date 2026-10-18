import { defineConfig } from 'tsup';

/**
 * 纯 Node 服务（Fastify）的打包配置 —— docs/06 M0.8。
 *
 * 为什么不用 tsc 直接出 dist：内部包（@crossbuy/*）的 package.json exports
 * 指向 `src/index.ts`（M0 决策「内部包走源码，Next 一并转译」），tsc 产物里
 * 的 bare import 在 node 运行时解析不了 TS 源 ⇒ ERR_MODULE_NOT_FOUND（M0.8
 * 实测踩坑）。tsup 把 workspace 包打进 bundle（noExternal），外部依赖
 * （fastify/pino/zod…）保持 external 走 node_modules，产物 = 单文件 ESM，
 * 可直接 `node dist/index.js`。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  noExternal: [
    '@crossbuy/config',
    '@crossbuy/contract',
    '@crossbuy/utils',
    '@crossbuy/auth',
    '@crossbuy/domain-order',
    '@crossbuy/domain-member',
    '@crossbuy/domain-send-order',
    '@crossbuy/db',
  ],
  sourcemap: true,
});
