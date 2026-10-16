#!/usr/bin/env node
/**
 * post-pull-fixup.mjs —— `prisma db pull` 后置修复（幂等，可反复跑）。两件事：
 *
 * ① 数字前缀模型撞名修复：
 *    旧库存在数字前缀的备份副本表（如 `0908_admin_extension_histories`）。Prisma model
 *    名禁数字开头，introspect 会剥掉 `NNNN_` 前缀 → 与真表模型撞名，`prisma generate`
 *    报 P1012「model already exists」。规则：凡 `@@map("NNNN_xxx")` 且模型名 = 剥前缀
 *    后的 `xxx`，模型名改回带前缀的安全形式 `xxx_NNNN`。只改模型名，不动 @@map/字段/索引
 *    （旧库零外键，无 relation 需要级联改）。
 *    ⚠ 2026-10-16 生产重拉实测：生产无数字前缀表（本机 dump 的 3 张 0908_* 是本地伪表），
 *      本条在生产是空转——保留是为了将来任何来源的 pull 不再被撞名打断。
 *
 * ② 恢复文件头注释：
 *    `prisma db pull` 会**整体重写** schema 文件，连头部注释一起冲掉（2026-10-16 实测：
 *    M0.1 手写的头部从未在提交里存在过）。头部正本 = prisma/legacy-header.txt（数据源
 *    声明 + 纪律），pull 后由本脚本重贴。改头部 = 改 legacy-header.txt，禁手改 schema 头。
 *
 * 用法：node scripts/post-pull-fixup.mjs [schema 路径]
 * 默认作用于 prisma/schema.prisma（R1 活跃 legacy schema）。
 * 已被 `pnpm --filter @crossbuy/db pull:legacy` 串在 db pull 之后自动执行。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRISMA_DIR = path.resolve(HERE, '..', 'prisma');
const schemaPath =
  process.argv[2] ?? path.resolve(PRISMA_DIR, 'schema.prisma');
const headerPath = path.resolve(PRISMA_DIR, 'legacy-header.txt');

const HEADER_MARKER = 'Prisma schema —— ★ R1 活跃 schema = 旧库 introspect';

let src = readFileSync(schemaPath, 'utf8');

// ---- ① 数字前缀撞名修复 ----
const MODEL_RE = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/gm;
let renamed = 0;
src = src.replace(MODEL_RE, (block, modelName, body) => {
  const mapMatch = body.match(/@@map\("([^"]+)"\)/);
  if (!mapMatch) return block;
  const prefixMatch = mapMatch[1].match(/^(\d+)_(.+)$/); // 如 0908_dg_sendorder
  if (!prefixMatch) return block;
  const [, prefix, base] = prefixMatch;
  if (modelName !== base) return block; // 仅「撞名」形态才修
  renamed += 1;
  return block.replace(
    new RegExp(`^model\\s+${modelName}\\s*\\{`, 'm'),
    `model ${base}_${prefix} {`,
  );
});

// ---- ② 头部恢复（pull 会冲掉；幂等：已在则不重复贴） ----
// 注意：头部首行是 `// ====` 分隔线，标记行在第 2 行 ⇒ 必须用 includes 判存在，
// 用 startsWith 会把「已贴过头」误判成「没贴」而重复贴（2026-10-16 实测踩过）。
let headerRestored = false;
if (existsSync(headerPath)) {
  const header = readFileSync(headerPath, 'utf8');
  if (!src.includes(HEADER_MARKER)) {
    // pull 产物以 generator 块开头：头部贴到最前面，与原有内容空一行隔开
    src = header.replace(/\n+$/, '') + '\n\n' + src.replace(/^\n+/, '');
    headerRestored = true;
  }
} else {
  console.warn(`[post-pull] WARN 头部正本缺失：${headerPath}`);
}

writeFileSync(schemaPath, src);
console.log(
  `[post-pull] renamed=${renamed} header_restored=${headerRestored} → ${schemaPath}`,
);
