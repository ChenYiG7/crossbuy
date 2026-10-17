import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Windows + monorepo + Prisma 组合坑两件套（从 apps/web/next.config.ts 复制，
 * 机制详解见该文件注释）。mzk 目前尚未 bundle Prisma（M2 交易链路才接入），
 * 提前带上：两件套对无 Prisma 的构建无害，防接入当天忘配死在编译期 trace。
 */
const REPO_ROOT = path.resolve(process.cwd(), '../..');

const nextConfig = (phase: string): NextConfig => {
  if (phase === 'phase-production-build') {
    process.env.USERPROFILE = 'D:\\crossbuy-build-home';
    process.env.HOME = 'D:\\crossbuy-build-home';
  }

  return {
    transpilePackages: [
      '@crossbuy/auth',
      '@crossbuy/contract',
      '@crossbuy/db',
      '@crossbuy/ui',
      '@crossbuy/utils',
    ],
    outputFileTracingRoot: REPO_ROOT,
    // M0.8（D3）：per-app standalone 产物（机制同 web）
    output: 'standalone',
  };
};

export default nextConfig;
