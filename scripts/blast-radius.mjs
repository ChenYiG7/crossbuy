#!/usr/bin/env node
/**
 * 发布影响半径计算（docs/04 §2 D3 + docs/06 M0.8）：
 *   node scripts/blast-radius.mjs [base-ref]
 *
 * base-ref 缺省 = HEAD（即算**未提交改动**）；传 ref 时算 `base...HEAD`。
 *
 * 分级规则（与 D3 表一一对应）：
 *   1. apps/<a>/**                     → 只有该 app
 *   2. packages/domains/<d>/** 或
 *      packages/contract/src/domains/<d>.ts → 该域全部写方（deploy/blast-radius.config.mjs）
 *   3. packages/contract 共享文件       → 全部消费 app
 *   4. packages/<p>/**                 → 反向依赖（package.json workspace deps 实时算）
 *   5. docs/ deploy/ scripts/ *.md     → 无需发版（标注列出）
 *
 * 输出按「需发布进程集合」去重合并；域写路径行会显式标 ⚠ 协同发布。
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DOMAIN_WRITERS,
  CONTRACT_DOMAIN_ALIASES,
  NO_DEPLOY_PREFIXES,
} from '../deploy/blast-radius.config.mjs';

const APPS = ['web', 'mzk', 'admin', 'api', 'worker'];
const ROOT = path.resolve(import.meta.dirname, '..');

function gitDiffFiles(base) {
  const range = base ? `${base}...HEAD` : 'HEAD';
  const out = execSync(`git -c core.quotepath=false diff --name-only ${range}`, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 包名（@crossbuy/web）→ 部署单元短名（web）；非 app 的包返回 null（库，不是部署单元） */
function toDeployUnit(pkgName) {
  const short = pkgName.replace('@crossbuy/', '');
  return APPS.includes(short) ? short : null;
}

/** workspace 包名 → { dir, deps }：apps/* + packages/* + packages/domains/* 全扫 */
function workspacePackages() {
  const map = new Map();
  const dirs = ['apps', 'packages', path.join('packages', 'domains')];
  for (const base of dirs) {
    const absBase = path.join(ROOT, base);
    if (!existsSync(absBase)) continue;
    for (const name of readdirSync(absBase)) {
      const pkgPath = path.join(absBase, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (!pkg.name?.startsWith('@crossbuy/')) continue;
        map.set(pkg.name, { dir: [base, name].join('/'), deps: pkg.dependencies ?? {} });
      } catch {
        /* 解析失败跳过 */
      }
    }
  }
  return map;
}

function classify(file, pkgs) {
  const appMatch = file.match(/^apps\/([^/]+)\//);
  if (appMatch && APPS.includes(appMatch[1])) {
    return { kind: 'app', app: appMatch[1], note: 'app 自身改动' };
  }

  const domainMatch =
    file.match(/^packages\/domains\/([^/]+)\//) ??
    file.match(/^packages\/contract\/src\/domains\/([^/]+)\.ts$/);
  if (domainMatch) {
    const domain = CONTRACT_DOMAIN_ALIASES[domainMatch[1]] ?? domainMatch[1];
    const writers = DOMAIN_WRITERS[domain];
    if (writers) return { kind: 'domain', domain, writers, note: `域写路径/契约 → 协同发写方` };
    return { kind: 'unknown-domain', domain, note: '未登记域（检查 blast-radius.config.mjs）' };
  }

  if (file.startsWith('packages/contract/')) {
    const consumers = [...pkgs.entries()].map(([k]) => toDeployUnit(k)).filter(Boolean);
    const rel = file.replace(/^packages\/contract\//, '');
    return {
      kind: 'contract-shared',
      consumers,
      note:
        rel === 'src/core.ts' || rel === 'src/index.ts'
          ? '共享契约 → 全部消费方'
          : '契约包其它文件 → 全部消费方（保守）',
    };
  }

  const pkgMatch = file.match(/^packages\/([^/]+)\//);
  if (pkgMatch) {
    // packages/domains/<d> 已在上面截获；这里处理 ui/db/config/auth/utils/notify
    const candidates = [...pkgs.entries()].filter(
      ([_name, v]) => v.dir === `packages/${pkgMatch[1]}`,
    );
    if (candidates.length === 1) {
      const [pkgName] = candidates[0];
      const consumers = [...pkgs.entries()]
        .filter(([, v]) => v.deps[pkgName])
        .map(([k]) => toDeployUnit(k))
        .filter(Boolean);
      if (consumers.length)
        return {
          kind: 'package',
          pkg: pkgMatch[1],
          consumers,
          note: `包 @crossbuy/${pkgMatch[1]} → 反向依赖（仅部署单元）`,
        };
    }
    return {
      kind: 'package-unmapped',
      pkg: pkgMatch[1],
      note: '未找到反向依赖（新包？检查扫描逻辑）',
    };
  }

  if (NO_DEPLOY_PREFIXES.some((p) => file.startsWith(p)) || /\.md$/.test(file)) {
    return { kind: 'no-deploy', note: '无需发版' };
  }

  return { kind: 'other', note: '仓库根杂项（pnpm-workspace/turbo 等）→ 保守：全量' };
}

function main() {
  const base = process.argv[2];
  const files = gitDiffFiles(base);
  if (!files.length) {
    console.log(`无改动（${base ? `${base}...HEAD` : '工作树 vs HEAD'}）——无需任何发版。`);
    return;
  }
  const pkgs = workspacePackages();
  const rows = files.map((f) => ({ file: f, ...classify(f, pkgs) }));

  const deploySet = new Set(); // 需发布 app 集合
  const coordinated = new Set(); // 域写路径协同标记
  const noDeploy = [];
  const alerts = [];

  for (const r of rows) {
    switch (r.kind) {
      case 'app':
        deploySet.add(r.app);
        break;
      case 'domain':
        r.writers.forEach((a) => deploySet.add(a));
        coordinated.add(r.domain);
        alerts.push(`${r.file} → 域 ${r.domain} 写方：${r.writers.join(', ')}（同窗口协同）`);
        break;
      case 'unknown-domain':
        alerts.push(
          `⚠ ${r.file} → 域 ${r.domain} 未登记写方清单，先补 deploy/blast-radius.config.mjs 再发版`,
        );
        break;
      case 'contract-shared':
        r.consumers.forEach((a) => deploySet.add(a));
        if (r.note.includes('共享契约'))
          alerts.push(`${r.file} → 共享契约：${r.consumers.join(', ')}`);
        break;
      case 'package':
        r.consumers.forEach((a) => deploySet.add(a));
        break;
      case 'package-unmapped':
        alerts.push(`⚠ ${r.file} → ${r.note}`);
        break;
      case 'other':
        alerts.push(`⚠ ${r.file} → ${r.note}`);
        break;
      case 'no-deploy':
        noDeploy.push(r.file);
        break;
    }
  }

  console.log(
    `== 影响半径（${base ? `${base}...HEAD` : '工作树 vs HEAD'}，${files.length} 文件）==\n`,
  );
  console.log(
    deploySet.size
      ? `需发布进程（${deploySet.size}）：${[...deploySet]
          .sort()
          .map((a) => `apps/${a}`)
          .join(', ')}`
      : '需发布进程：无',
  );
  if (coordinated.size) {
    console.log(`⚠ 域写路径协同（D3）：${[...coordinated].join(', ')} —— 上述写方进程须同窗口发布`);
  }
  if (alerts.length) {
    console.log(`\n明细警示：\n${alerts.map((a) => `  ${a}`).join('\n')}`);
  }
  console.log(`\n无需发版（${noDeploy.length}）：${noDeploy.length ? noDeploy.join(', ') : '—'}`);
  console.log(`\n逐文件归类：`);
  for (const r of rows) {
    console.log(
      `  ${r.file}  →  ${r.kind}${r.app ? `(${r.app})` : ''}${r.domain ? `(${r.domain})` : ''}${r.consumers ? `(${r.consumers.join(',')})` : ''}`,
    );
  }
}

main();
