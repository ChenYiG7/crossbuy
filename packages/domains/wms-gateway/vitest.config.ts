import { defineConfig } from 'vitest/config';

/**
 * wms-gateway 域测试配置（2026-10-20 适配层骨架）。
 *
 * 纯单测：不连 MySQL / Redis——适配层本域**不持有表**（WMS 业务外迁黑舟，
 * docs/04 §3.1），幂等与 order 状态应用都走端口，测试用内存 fake 钉死行为；
 * 组合根接线（@crossbuy/cache IdempotencyStore / order 域 service）随
 * 黑舟协议定版（TODO(#20)）在 apps/api 落地。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
});
