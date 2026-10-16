#!/usr/bin/env node
/**
 * smoke-clients.mjs —— 双 Prisma client 运行时冒烟（M0.1 验收：两套 client 可用）。
 *
 * 分别验证：
 *   legacy   client → 连旧库（R1 活跃 schema，dg_users 等 160 表）
 *   redesign client → 连 60 模型新表（R2 封存资产，crossbuy_t1v 演练库）
 *
 * 用法（DATABASE_URL 指向对应库）：
 *   DATABASE_URL="mysql://root:root@127.0.0.1:3306/taotaro"       node scripts/smoke-clients.mjs legacy
 *   DATABASE_URL="mysql://root:root@127.0.0.1:3306/crossbuy_t1v"  node scripts/smoke-clients.mjs redesign
 *
 * 判定：打印 JSON { client, table, rows }；连接失败/查询报错即非零退出。
 */
const mode = process.argv[2];

if (mode !== 'legacy' && mode !== 'redesign') {
  console.error('usage: node scripts/smoke-clients.mjs <legacy|redesign>');
  process.exit(2);
}

const entry =
  mode === 'legacy'
    ? '../src/generated/legacy/index.js'
    : '../src/generated/redesign/index.js';

const { PrismaClient } = await import(entry);
const client = new PrismaClient();

try {
  const rows =
    mode === 'legacy'
      ? await client.dg_users.count()
      : await client.member.count();
  console.log(
    JSON.stringify({
      client: mode,
      table: mode === 'legacy' ? 'dg_users' : 'member',
      rows,
    }),
  );
} finally {
  await client.$disconnect();
}
