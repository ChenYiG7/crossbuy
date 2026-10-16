#!/usr/bin/env node
/**
 * fixup-legacy-model-names.mjs —— `prisma db pull` 后置修复（幂等，可反复跑）。
 *
 * 背景：旧库存在数字前缀的备份副本表（如 `0908_admin_extension_histories`，
 * 本机 dump 实测 3 张：0908_admin_extension_histories / 0908_dg_sendorder /
 * 0908_dg_stores；生产的 deprecated_ 族同理）。Prisma model 名禁数字开头，
 * introspect 会剥掉 `NNNN_` 前缀 → 与真表模型撞名，`prisma generate` 报
 * P1012「model already exists」。
 *
 * 修复规则：凡 `@@map("NNNN_xxx")` 且模型名 = 去掉 `NNNN_` 后的 `xxx`，
 * 一律把模型名改回带前缀的安全形式 `xxx_NNNN`（如 admin_extension_histories_0908）。
 * 只改模型名，不动 @@map/字段/索引——旧库零外键，无 relation 需要级联改。
 *
 * 用法：node scripts/fixup-legacy-model-names.mjs [schema 路径]
 * 默认作用于 prisma/schema.prisma（R1 活跃 legacy schema）。
 * 已被 `pnpm --filter @crossbuy/db pull:legacy` 串在 db pull 之后自动执行。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const schemaPath =
  process.argv[2] ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'prisma',
    'schema.prisma',
  );

const src = readFileSync(schemaPath, 'utf8');

// 逐模型块扫描：model <name> { ... }，捕获模型名与其中的 @@map("...")
const MODEL_RE = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/gm;

let renamed = 0;
const out = src.replace(MODEL_RE, (block, modelName, body) => {
  const mapMatch = body.match(/@@map\("([^"]+)"\)/);
  if (!mapMatch) return block;
  const tableName = mapMatch[1];
  const prefixMatch = tableName.match(/^(\d+)_(.+)$/); // 如 0908_dg_sendorder
  if (!prefixMatch) return block;
  const [, prefix, base] = prefixMatch;
  // 仅当「撞名」形态（模型名 = 剥前缀后的基名）才修；其他形态不碰
  if (modelName !== base) return block;
  const newName = `${base}_${prefix}`;
  renamed += 1;
  return block.replace(
    new RegExp(`^model\\s+${modelName}\\s*\\{`, 'm'),
    `model ${newName} {`,
  );
});

if (renamed === 0) {
  console.log('[fixup] no numeric-prefix model collisions found — nothing to do');
} else {
  writeFileSync(schemaPath, out);
  console.log(`[fixup] renamed ${renamed} numeric-prefix model(s) in ${schemaPath}`);
}
