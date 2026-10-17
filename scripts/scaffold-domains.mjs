#!/usr/bin/env node
/**
 * scaffold-domains.mjs —— packages/domains/* 骨架生成器（M0.2，docs/04 §3.1）。
 *
 * 为什么用脚本而不是手写：11 个域包结构同构（铁律 8「同构样板禁 AI 手写」），
 * 脚本 = 可复用的第二遍生成器 + 结构一致性的唯一来源。
 *
 * 每个域包生成：
 *   package.json / tsconfig.json
 *   src/errors.ts      域错误类型（Result 分支用）
 *   src/repository.ts  防腐层——本域唯一允许 import @crossbuy/db 的位置
 *   src/service.ts     域服务接口 + 实现壳（域间唯一调用面）
 *   src/index.ts       公开出口
 *
 * 用法：
 *   node scripts/scaffold-domains.mjs           # 增量生成（已存在的包跳过）
 *   node scripts/scaffold-domains.mjs --force   # 覆盖已存在域包的生成文件
 *
 * 生成后必须：pnpm install（链接 workspace 依赖）→ pnpm typecheck。
 * 边界规则（PrismaClient 仅 repository / 域间禁 import / contract 禁 ORM）
 * 在 eslint.config.mjs，破坏验证用 scripts/boundary-probe.mjs。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');

/** 12 域清单（docs/04 §3.1 + 2026-10-17 增补 admin；R3 归属列 = 拆分时的搬运目标） */
const DOMAINS = [
  { name: 'member', label: '会员', legacy: 'Services/Member、Models/User*', r3: 'CRM（+认证中心的用户资料）' },
  { name: 'admin', label: '后台管理员/RBAC/操作日志', legacy: 'app/Admin、Models/AdminUser、dcat-admin 权限表族（R1 零新表唯一例外）', r3: '独立后台基座' },
  { name: 'order', label: '购物车/下单/订单', legacy: 'Services/Order', r3: 'oms' },
  { name: 'purchase', label: '采购/1688/淘宝代购/砍价', legacy: 'Services/Order 内采购逻辑', r3: 'oms' },
  { name: 'send-order', label: '运单/合包/发货/发票', legacy: 'Services/SendOrder*', r3: 'oms' },
  { name: 'logistics', label: '物流轨迹/承运商', legacy: 'Services/Logistics', r3: 'oms' },
  { name: 'platform', label: '外部平台对接（1688/淘宝全球购/Shopify/Rakuten/TheBase/Amazon）', legacy: 'Services/Platform*', r3: 'oms 对接层' },
  { name: 'finance', label: '余额写/充值/支付/汇率', legacy: 'Services/Finance', r3: '财务系统（R3 落账本/对账）' },
  { name: 'ticket', label: '工单/询价/留言', legacy: 'Services/Ticket', r3: 'CRM' },
  { name: 'content', label: 'CMS/博客/文章', legacy: 'Services/Cms', r3: 'CRM/官网站点' },
  { name: 'openapi', label: '会员开放 API', legacy: 'routes/api open 段', r3: '独立开放平台' },
  { name: 'wms-gateway', label: '库存查询/到货同步接口面', legacy: 'Models/Wms', r3: 'wms（独立项目 own/wms，不并入）' },
];

const pascal = (name) =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const pkgJson = (d) =>
  JSON.stringify(
    {
      name: `@crossbuy/domain-${d.name}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      scripts: {
        build: 'tsc -p tsconfig.json',
        typecheck: 'tsc --noEmit',
        lint: 'eslint src',
        test: 'echo "(no tests yet)"',
      },
      dependencies: {
        '@crossbuy/auth': 'workspace:*',
        '@crossbuy/contract': 'workspace:*',
        '@crossbuy/db': 'workspace:*',
        '@crossbuy/utils': 'workspace:*',
      },
      devDependencies: {
        '@types/node': 'catalog:',
        typescript: 'catalog:',
      },
    },
    null,
    2,
  ) + '\n';

const tsconfigJson = () =>
  JSON.stringify(
    {
      extends: '../../../tsconfig.base.json', // packages/domains/<name>/ → 仓根，三级
      compilerOptions: { outDir: 'dist', rootDir: 'src' },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  ) + '\n';

const errorsTs = (d) => `/**
 * ${d.label} 域错误（docs/07：可预期业务失败走 Result，禁抛异常承载分支）。
 * 错误码词表随域方法铺开时登记到 packages/contract/domains/${d.name}.ts，
 * 与统一响应体 / 开放 API 业务码共用一套词汇（docs/04 §4-3）。
 */
export interface ${pascal(d.name)}Error {
  readonly code: string;
  readonly message: string;
}
`;

const repositoryTs = (d) => `import { legacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';

/**
 * ${d.label} 域 repository 防腐层（docs/04 §5 / docs/07）。
 *
 * 本文件是 ${d.name} 域唯一允许 import @crossbuy/db 的位置——ESLint 边界规则强制，
 * 全仓其他位置 import 即 lint error（守卫有效性由 scripts/boundary-probe.mjs 破坏验证）。
 *
 * 纪律：
 * - 旧表原样读写，禁顺手清理列名；复现怪癖必须 1:1 并登记 docs/plans/08
 * - 时间戳 Asia/Shanghai 语义；金额读入即转 Decimal（utils/money 单入口）
 * - 别域数据禁直连表：跨域读走属主域 service 接口（docs/04 §3.2-1）
 * - 写路径唯一入口 + 状态机 CAS（UPDATE ... WHERE status=from）随域铺开时落
 * - 属主旧表清单见 docs/plans/07-表属主映射.md
 */
export class ${pascal(d.name)}Repository {
  constructor(protected readonly db: LegacyPrismaClient = legacyPrisma) {}
}
`;

const serviceTs = (d) => `import type { ${pascal(d.name)}Repository } from './repository';

/**
 * ${d.label} 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：${d.legacy}；R3 归属：${d.r3}
 */
export interface ${pascal(d.name)}Service {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: '${d.name}';
}

export class ${pascal(d.name)}ServiceImpl implements ${pascal(d.name)}Service {
  readonly domain = '${d.name}' as const;

  constructor(protected readonly repository: ${pascal(d.name)}Repository) {}
}
`;

const indexTs = (d) => `export * from './errors';
export * from './repository';
export * from './service';
`;

let created = 0;
let skipped = 0;

for (const d of DOMAINS) {
  const dir = path.join(ROOT, 'packages', 'domains', d.name);
  const files = {
    'package.json': pkgJson(d),
    'tsconfig.json': tsconfigJson(),
    'src/index.ts': indexTs(d),
    'src/errors.ts': errorsTs(d),
    'src/repository.ts': repositoryTs(d),
    'src/service.ts': serviceTs(d),
  };

  const existing = existsSync(path.join(dir, 'package.json'));
  if (existing && !FORCE) {
    console.log(`[skip] ${d.name}（已存在；--force 可覆盖生成文件）`);
    skipped += 1;
    continue;
  }

  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  console.log(`[gen ] @crossbuy/domain-${d.name}（${pascal(d.name)}Repository / ${pascal(d.name)}ServiceImpl）`);
  created += 1;
}

console.log(`\n完成：生成 ${created} 个域包，跳过 ${skipped} 个。`);
console.log('下一步：pnpm install（链接 workspace 依赖）→ pnpm typecheck → node scripts/boundary-probe.mjs（守卫破坏验证）');
