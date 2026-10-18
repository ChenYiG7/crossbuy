import { defineConfig } from 'vitest/config';

/**
 * member 域测试配置（M0.9 基线）。
 *
 * 连**真实 MySQL 快照**跑（docs/06 任务 0.9 验收口径：不是 mock，
 * 因为 R1 复现期的风险恰恰在旧库真实数据与 Prisma 映射的错位上）。
 *
 * 数据源：TEST_DATABASE_URL，缺省回落到本机 dump 库 `taotaro`（FlyEnv MySQL；
 * 生产 dump 切片，只读参考用）。CI/他人环境请显式设置 TEST_DATABASE_URL。
 * ⚠ 凭据只走环境变量，不写进本文件（记忆坑⑦：命令里内联密码会被脱敏成假值）。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // 单例/并发：DB 测试串行，避免同库互相踩
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'mysql://root:root@127.0.0.1:3306/taotaro',
    },
  },
});
