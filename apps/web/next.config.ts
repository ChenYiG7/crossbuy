import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * ★ Windows + monorepo + Prisma 组合坑的修法（2026-10-17 两轮实锤，M1 member 页把
 * repository 接进 web 后才真触发——M0.6 期 web 没 bundle Prisma，构建绿是假绿）：
 *
 * 链路：web bundle 进 Prisma 生成客户端 → 其 runtime 内置 dotenv 的 `~` 路径解析
 * （path.join(os.homedir(), 动态串)）→ nft 纯表达式求值把 os.homedir() 算成
 * `C:\Users\<user>` 并 glob 整个 home → Windows profile 下的 socket/junction
 * scandir EACCES → **编译期 trace 直接失败**（构建编译成功、死在 trace，典型的
 * 「跑绿≠能构建」）。
 *
 * 修法两件套（都必需，缺一不可）：
 *
 * ① `outputFileTracingRoot` 配置字段（**不能只设 env**）：nft 的 ignore 有一条
 * 「相对 base 以 `..\` 开头 → 忽略」的规则。首版只设 env NEXT_PRIVATE_OUTPUT_TRACE_ROOT
 * ——不生效：config-shared.js 的默认值 `outputFileTracingRoot: process.env.
 * NEXT_PRIVATE_OUTPUT_TRACE_ROOT || ''` 在**模块导入时**就已求值成 ''，next.config.ts
 * 加载在 defaults 生成之后 ⇒ env 设了也白设。config.js 直接用 result.outputFileTracingRoot，
 * 走配置字段才是权威入口。
 *
 * ② **USERPROFILE 重定向（跨盘 relative 坑的正解）**：nft 的 ignore 判据是
 * `path.relative(base, glob目标)`。**Windows 下 base 与目标不在同一盘符时，
 * path.relative 原样返回目标路径**（D: 仓盘 vs C: 用户盘）⇒ rel = `C:\Users\...`
 * 不以 `..\` 开头 ⇒ 忽略规则失效 ⇒ glob 整个 home。把 USERPROFILE/HOME 指到**同盘
 * （D:）的构建专用目录**后，glob 目标变成 `D:\crossbuy-build-home\**\*`（整目录），
 * rel = `..\crossbuy-build-home\**\*` → 命中忽略规则 → 不再扫 home。
 * 实测：重定向前构建必挂（EACCES jb.station.*.sock），重定向后全绿。
 * 目录无需真实存在（glob 空目录即空结果）；仅 production build 生效（dev 不跑 trace）。
 *
 * 副作用（正向）：.nft.json 追踪路径相对仓库根，standalone 部署目录与 monorepo 一致。
 * ⚠ apps/mzk、apps/admin 一旦 bundle 进 Prisma（M2 起）需复制同样两件套。
 */
const REPO_ROOT = path.resolve(process.cwd(), '../..');

const nextConfig = (phase: string): NextConfig => {
  // 仅生产构建重定向（trace 只在 build 跑；dev 保持真实 home）。
  // ⚠ 不能读 process.env.NEXT_PHASE——它在本配置求值**之后**才被 build/index.js 赋值；
  //   拿 phase 只能用函数式配置的入参（loadConfig(PHASE_PRODUCTION_BUILD, ...) 传入）。
  if (phase === 'phase-production-build') {
    process.env.USERPROFILE = 'D:\\crossbuy-build-home';
    process.env.HOME = 'D:\\crossbuy-build-home';
  }

  return {
    // 内部包走源码（exports 指向 src/index.ts），让 Next 一并转译
    transpilePackages: [
      '@crossbuy/auth',
      '@crossbuy/cache',
      '@crossbuy/contract',
      '@crossbuy/db',
      '@crossbuy/domain-member',
      '@crossbuy/jobs',
      '@crossbuy/ui',
      '@crossbuy/utils',
    ],
    // ① 文件追踪根 = 仓库根（monorepo 权威值）
    outputFileTracingRoot: REPO_ROOT,
    // M0.8（D3）：per-app standalone 产物——每个 Next app = 独立部署单元，
    // 产物自带精简 node_modules，scripts/deploy.mjs 据此组装发布目录。
    output: 'standalone',
  };
};

export default nextConfig;
