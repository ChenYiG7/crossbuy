import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 内部包走源码（exports 指向 src/index.ts），让 Next 一并转译
  transpilePackages: [
    '@crossbuy/auth',
    '@crossbuy/contract',
    '@crossbuy/db',
    '@crossbuy/ui',
    '@crossbuy/utils',
  ],
};

export default nextConfig;
