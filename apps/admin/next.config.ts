import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * i18n 接线（机制说明见 apps/web/next.config.ts 同段注释）：
 * 函数式配置自行组合插件，保留 phase 入参语义。
 */
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * ★ Windows + monorepo + Prisma 组合坑两件套（从 apps/web/next.config.ts 复制，
 * 机制详解见该文件注释——2026-10-17 两轮实锤）。
 *
 * admin 在 M1 §四-4 接入 domain-admin/domain-member（后台登录 + 用户列表），
 * 首次 bundle 进 Prisma 生成客户端 ⇒ 不加两件套，`next build` 死在编译期 trace
 * （nft 纯表达式求值把 Prisma runtime 内置 dotenv 的 `~` 解析成
 * `C:\Users\<user>\**\*` 并 glob 整个 home，Windows profile scandir EACCES）。
 */
const REPO_ROOT = path.resolve(process.cwd(), '../..');

const nextConfig = (phase: string): NextConfig => {
  // 仅生产构建重定向（trace 只在 build 跑；dev 保持真实 home）。
  // ⚠ 不能读 process.env.NEXT_PHASE——它在本配置求值之后才被赋值；phase 走函数式入参。
  if (phase === 'phase-production-build') {
    process.env.USERPROFILE = 'D:\\crossbuy-build-home';
    process.env.HOME = 'D:\\crossbuy-build-home';
  }

  return {
    transpilePackages: [
      '@crossbuy/auth',
      '@crossbuy/contract',
      '@crossbuy/db',
      '@crossbuy/domain-admin',
      '@crossbuy/domain-member',
      '@crossbuy/ui',
      '@crossbuy/utils',
    ],
    outputFileTracingRoot: REPO_ROOT,
    // M0.8（D3）：per-app standalone 产物（机制同 web）
    output: 'standalone',
  };
};

export default (phase: string) => withNextIntl(nextConfig(phase));
