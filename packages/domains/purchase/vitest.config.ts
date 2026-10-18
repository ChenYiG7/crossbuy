import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * purchase 域测试配置（本文件只收**纯逻辑**用例——SDK 签名/轮换/提取）。
 *
 * DB 面用例沿用「连真实 MySQL 快照」纪律：ALI 层测试连 TEST_DATABASE_URL
 * （缺省本机 dump 库）。当前 alibaba-sdk 的用例不触 DB（HTTP 端口注入假实现），
 * 因此不需要 DATABASE_URL。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
  },
});
