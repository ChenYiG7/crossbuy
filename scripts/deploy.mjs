#!/usr/bin/env node
/**
 * per-app 发布组装（docs/04 §2 D3 + docs/06 M0.8）：
 *   node scripts/deploy.mjs <web|mzk|admin|api|worker> [--list]
 *
 * D3：仓库 ≠ 部署单元。本脚本**只组装单个 app** 的发布目录（构建依赖图由
 * turbo 保证：改单 app → 只有它重建，其余缓存命中），产物落在
 *   releases/<app>/<release-id>/
 * release-id = <utc 时间戳>-<git 短 sha>（同 sha 可重复组装覆盖，幂等）。
 *
 * 产物形态：
 *   - web/mzk/admin：Next standalone（自带精简 node_modules），叠上 .next/static
 *     与 public（standalone 不包含它们，官方要求手工补齐），入口 server.js；
 *     启动 = `node apps/<app>/server.js`（目录结构与 monorepo 相对路径一致，
 *     这是 outputFileTracingRoot=仓库根 的既定副作用）。
 *   - api/worker：`pnpm deploy --prod`（dist + 生产依赖打平，workspace 包以
 *     打包副本注入，无 symlink），入口 `node dist/index.js`。
 *
 * 服务器侧（rsync + 蓝绿切换）流程见 deploy/README.md——本机只到「可 rsync 的
 * 发布目录」为止，远端操作不进脚本（无凭据进仓红线）。
 */
import { execSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASES = path.join(ROOT, 'releases');
const NEXT_APPS = new Set(['web', 'mzk', 'admin']);
const NODE_APPS = new Set(['api', 'worker']);

const app = process.argv[2];
if (process.argv.includes('--list')) {
  if (!existsSync(RELEASES)) {
    console.log('（releases/ 不存在——尚未组装过）');
  } else {
    for (const dir of readdirSync(RELEASES)) {
      const p = path.join(RELEASES, dir);
      if (!statSync(p).isDirectory()) continue;
      console.log(`${dir}: ${readdirSync(p).join(', ') || '（空）'}`);
    }
  }
} else if (!app || (!NEXT_APPS.has(app) && !NODE_APPS.has(app))) {
  console.error('用法：node scripts/deploy.mjs <web|mzk|admin|api|worker>  （或 --list）');
  process.exit(1);
}

function sh(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`✗ 命令失败（exit ${r.status}）：${cmd}`);
    process.exit(r.status ?? 1);
  }
}

function shortSha() {
  return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
}

// 1. 构建该 app（turbo 依赖图：^build + generate；改单 app 其余缓存命中）
const pkgName = `@crossbuy/${app}`;
sh(`pnpm exec turbo run build --filter=${pkgName}`);

// 2. release-id 与目录
const id = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)}-${shortSha()}`;
const outDir = path.join(RELEASES, app, id);
const srcDir = path.join(ROOT, 'apps', app);
let startCmd;

if (NEXT_APPS.has(app)) {
  const standalone = path.join(srcDir, '.next', 'standalone');
  const serverJs = path.join(standalone, 'apps', app, 'server.js');
  if (!existsSync(serverJs)) {
    console.error(
      `✗ standalone 产物缺 server.js（期望 ${path.relative(ROOT, serverJs)}）——检查 output:'standalone' 是否生效`,
    );
    process.exit(1);
  }
  // standalone 目录树整体拷贝（含 apps/<app>/server.js 与仓库根 node_modules 副本）
  cpSync(standalone, outDir, { recursive: true });
  // 官方要求补齐：静态资源与 public 不进 standalone
  cpSync(path.join(srcDir, '.next', 'static'), path.join(outDir, 'apps', app, '.next', 'static'), {
    recursive: true,
  });
  if (existsSync(path.join(srcDir, 'public'))) {
    cpSync(path.join(srcDir, 'public'), path.join(outDir, 'apps', app, 'public'), {
      recursive: true,
    });
  }
  startCmd = `PORT=<port> HOSTNAME=127.0.0.1 node apps/${app}/server.js`;
} else {
  // pnpm deploy：目标必须是**不存在的目录**，且相对路径按「被 filter 的包目录」解析
  // （实测 apps/api/releases/ 下落物）——必须传绝对路径。⚠ Git Bash 的 /tmp 之类
  // POSIX 路径 pnpm 拼接会炸（cwd+target 直连），node path.resolve 出的 Windows
  // 绝对路径没问题。
  rmSync(outDir, { recursive: true, force: true });
  // bin-links=false：运行态直接 node dist/index.js，不需要依赖的 .bin shim；
  // 且 Windows 下 pnpm 写 .bin 偶发 EPERM（文件锁/杀软），部署产物里本就不该有
  sh(`pnpm --filter ${pkgName} deploy --prod --config.bin-links=false "${outDir}"`);
  // pnpm deploy 会把目标目录树也拷进包内容（实测产生空壳 releases/），清掉
  if (existsSync(path.join(outDir, 'releases'))) {
    rmSync(path.join(outDir, 'releases'), { recursive: true, force: true });
  }
  if (!existsSync(path.join(outDir, 'dist', 'index.js'))) {
    console.error(`✗ 产物缺 dist/index.js——检查 apps/${app} 构建输出`);
    process.exit(1);
  }
  startCmd = `node dist/index.js`;
}

// 3. MANIFEST（回滚审计用：哪个目录是哪次提交的哪个 app）
const manifest = {
  app,
  package: pkgName,
  releaseId: id,
  gitSha: shortSha(),
  builtAt: new Date().toISOString(),
  entry: startCmd,
};
writeFileSync(path.join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

console.log(`\n✓ 发布目录就绪：releases/${app}/${id}`);
console.log(`  本地试跑：cd releases/${app}/${id} && ${startCmd.replace('<port>', '3100')}`);
console.log(`  上传切换：见 deploy/README.md（rsync + nginx 蓝绿，不在本脚本内）`);
