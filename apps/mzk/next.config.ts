import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@crossbuy/auth',
    '@crossbuy/contract',
    '@crossbuy/db',
    '@crossbuy/ui',
    '@crossbuy/utils',
  ],
};

export default nextConfig;
