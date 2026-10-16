#!/usr/bin/env node
/**
 * smoke-clients.mjs —— 双 Prisma client 运行时冒烟（M0.1 验收：两套 client 可用）。
 *
 * 分别验证：
 *   legacy   client → 连旧库（R1 活跃 schema）。打两张表：dg_users（主表）
 *                + v2_worldfirst_trade_order（生产独有表——本机 dump 没有，
 *                  打到它 = 证明当前 schema 是生产 179 表版而非本地 160 表版）
 *   redesign client → 连 60 模型新表（R2 封存资产，crossbuy_t1v 演练库）
 *
 * 用法（DATABASE_URL 指向对应库）：
 *   # 本机 dump（160 表版 schema 时的旧命令；v2_worldfirst_trade_order 会查不到表）
 *   DATABASE_URL="mysql://root:root@127.0.0.1:3306/taotaro"       node scripts/smoke-clients.mjs legacy
 *   # 生产（跳板机隧道 127.0.0.1:13306；gouba007 只读）
 *   DATABASE_URL="mysql://gouba007:<urlencoded-pass>@127.0.0.1:13306/taotaro" node scripts/smoke-clients.mjs legacy
 *   # R2 演练库
 *   DATABASE_URL="mysql://root:root@127.0.0.1:3306/crossbuy_t1v"  node scripts/smoke-clients.mjs redesign
 *
 * 判定：打印 JSON { client, counts }；连接失败/查询报错即非零退出。
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
  const counts = {};
  if (mode === 'legacy') {
    counts.dg_users = await client.dg_users.count();
    // 注意：introspect 出的 snake_case 模型名，Prisma delegate 保留下划线原样
    //（不 camelCase）——client.dg_users / client.v2_worldfirst_trade_order
    counts.v2_worldfirst_trade_order =
      await client.v2_worldfirst_trade_order.count();
  } else {
    counts.member = await client.member.count();
  }
  console.log(JSON.stringify({ client: mode, counts }));
} finally {
  await client.$disconnect();
}
