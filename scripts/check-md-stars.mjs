#!/usr/bin/env node
/**
 * Markdown 裸星号守卫（#6-b，2026-10-18）。
 *
 * 背景（血泪坑 #15）：prettier 的 markdown 格式化会把**裸文里成对的单星号**当强调
 * 符号，标准化成 `_`（`*em*` → `_em_`）。本仓大量 glob 写法（`docs/*`、`dg_*`、
 * `v2_ecommerce_*`）一旦裸写，`pnpm format` 就会被静默改写（实测 2 文件 3 处中招）。
 *
 * 规则：`*` 只允许出现在——
 *   ① 围栏代码块 / 行内 code span 内（prettier 保护，不转换）
 *   ② `**bold**` 对（prettier 不转换加粗）
 *   ③ 转义形态 `\*`（显式声明「这是字面星号」）
 * 其余裸文中的单星号一律报错——glob/通配符写法必须进 code span。
 *
 * 用法：`node scripts/check-md-stars.mjs`（CI 门禁一环；rc=1 有裸星号）。
 * 扫描范围：仓库全部 .md（node_modules/.git/.next/.turbo/.workbuddy/skills/memory 除外——
 * 后两者为上游生成物/项目记忆，已进 .prettierignore 不受 prettier 改写，无本守卫针对的风险）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.workbuddy',
  'dist',
  'skills',
  'memory',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk('.')) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // 顺序有讲究：先剥行内 code span（glob 的安全区）→ 再去掉转义星号（字面量，
    // prettier 不碰）→ 最后剥 **bold** 对（bold 内可能含 \*，先转义后加粗才剥得动）
    const stripped = line
      .replace(/`[^`]*`/g, '')
      .replace(/\\\*/g, '')
      .replace(/\*\*[^*]*\*\*/g, '');
    if (stripped.includes('*')) {
      offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    `[md-stars] 发现 ${offenders.length} 处裸文单星号（会被 prettier 转成 _，glob 请包反引号）：`,
  );
  for (const o of offenders) console.error('  ' + o);
  process.exit(1);
}
console.log('[md-stars] OK：无裸文单星号');
