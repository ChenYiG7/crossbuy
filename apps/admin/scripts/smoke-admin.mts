/**
 * admin 端到端冒烟（M1 §四-4）——登录 / RBAC 数据范围 / 只读用户列表 / 登出。
 *
 * 数据隔离：自建 scratch 库（结构与 dump 同构 + 受控夹具），跑完即 DROP，
 * 不碰 dump 库。克隆表：dg_users + admin_* 六表（RBAC 判定所需最小集）。
 * 前置：`pnpm --filter @crossbuy/admin build`（next start 需要生产构建）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import bcrypt from 'bcryptjs';

// 凭据口径与成员域 vitest / web smoke 一致（TEST_DATABASE_URL 优先，缺省本机 dump 库）；
// 必须在 import @crossbuy/db（实例化 PrismaClient）之前赋值
process.env.DATABASE_URL ??= 'mysql://root:root@127.0.0.1:3306/taotaro';
const { legacyPrisma } = await import('@crossbuy/db');

const PORT = 3012;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH_DB = 'crossbuy_e2e_admin';
const SOURCE_DB = 'taotaro';
const SECRET = 'admin-smoke-secret-0123456789abcdef';

const ADMIN_PW = 'admin-smoke-pw';
const ADMIN1 = 'vitest-admin-flags'; // business_manager=["G"]，无 view-all 权限
const ADMIN2 = 'vitest-admin-all'; // 有 view-all 权限
const MEMBER_G = 'vitest-admin-member-g';
const MEMBER_H = 'vitest-admin-member-h';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function setupScratch(): Promise<void> {
  await legacyPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await legacyPrisma.$executeRawUnsafe(
    `CREATE DATABASE ${SCRATCH_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  for (const t of [
    'dg_users',
    'admin_users',
    'admin_roles',
    'admin_role_users',
    'admin_permissions',
    'admin_role_permissions',
  ]) {
    await legacyPrisma.$executeRawUnsafe(`CREATE TABLE ${SCRATCH_DB}.${t} LIKE ${SOURCE_DB}.${t}`);
  }

  // 夹具管理员（bcrypt 与旧 dcat 同构；业务员分组 ["G"]）
  const hash = bcrypt.hashSync(ADMIN_PW, 10);
  const a1 = await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.admin_users (username, password, name, business_manager)
     VALUES ('${ADMIN1}', '${hash}', '测试业务员甲', '["G"]')`,
  );
  const a2 = await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.admin_users (username, password, name, business_manager)
     VALUES ('${ADMIN2}', '${hash}', '测试管理员乙', '')`,
  );

  // admin2 → 新角色 → view-all 权限（CREATE TABLE LIKE 只克隆结构不拷数据，
  // 权限行需自插夹具——slug 唯一键在 scratch 内自洽，不依赖 dump 数据）
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.admin_roles (name, slug) VALUES ('vitest 全量角色', 'vitest_view_all')`,
  );
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.admin_permissions (name, slug) VALUES ('vitest 查看所有用户', 'ability-view-all-users')`,
  );
  const roleId = BigInt(
    (
      (await legacyPrisma.$queryRawUnsafe<{ id: bigint }[]>(
        `SELECT id FROM ${SCRATCH_DB}.admin_roles WHERE slug = 'vitest_view_all'`,
      )) as { id: bigint }[]
    )[0].id,
  );
  const permId = BigInt(
    (
      (await legacyPrisma.$queryRawUnsafe<{ id: bigint }[]>(
        `SELECT id FROM ${SCRATCH_DB}.admin_permissions WHERE slug = 'ability-view-all-users'`,
      )) as { id: bigint }[]
    )[0].id,
  );
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.admin_role_permissions (role_id, permission_id) VALUES (${roleId}, ${permId})`,
  );
  const a2Id = BigInt(
    (
      (await legacyPrisma.$queryRawUnsafe<{ id: bigint }[]>(
        `SELECT id FROM ${SCRATCH_DB}.admin_users WHERE username = '${ADMIN2}'`,
      )) as { id: bigint }[]
    )[0].id,
  );
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.admin_role_users (role_id, user_id) VALUES (${roleId}, ${a2Id})`,
  );

  // 会员夹具：G 分组 / H 分组 各一人
  const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.dg_users (uname, password, card, validity, memberid, email, money)
     VALUES ('${MEMBER_G}', '${md5('x')}', 'e2e', 1, 'G001', '${MEMBER_G}@e2e.test', '77.50')`,
  );
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.dg_users (uname, password, card, validity, memberid, email, money)
     VALUES ('${MEMBER_H}', '${md5('x')}', 'e2e', 1, 'H001', '${MEMBER_H}@e2e.test', '10.00')`,
  );
}

async function dropScratch(): Promise<void> {
  await legacyPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
}

function startServer(): ChildProcess {
  return spawn('npx', ['next', 'start', '-p', String(PORT)], {
    cwd: process.cwd(),
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: `mysql://root:root@127.0.0.1:3306/${SCRATCH_DB}`,
      AUTH_SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(child: ChildProcess, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/login`);
      if (res.status === 200) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

interface Res {
  status: number;
  text: string;
  location?: string;
  setCookie?: string;
}

async function call(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; follow?: boolean } = {},
): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: opts.follow === false ? 'manual' : 'follow',
    headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie = res.headers.get('set-cookie') ?? undefined;
  return {
    status: res.status,
    text: await res.text(),
    location: res.headers.get('location') ?? undefined,
    setCookie,
  };
}

async function main(): Promise<void> {
  await setupScratch();
  const server = startServer();
  const serverLog: string[] = [];
  server.stdout?.on('data', (d: Buffer) => serverLog.push(d.toString()));
  server.stderr?.on('data', (d: Buffer) => serverLog.push(d.toString()));
  try {
    console.log(`[1] 服务就绪`);
    check('next start 就绪', await waitReady(server));

    console.log('[2] 未登录 → /login');
    const anonUsers = await call('GET', '/users', { follow: false });
    check(
      '未登录 /users → 3xx 重定向 /login',
      anonUsers.status >= 300 && anonUsers.status < 400 && anonUsers.location?.startsWith('/login'),
      anonUsers,
    );

    console.log('[3] 登录（flags 业务员）');
    const bad = await call('POST', '/api/admin/v1/auth/login', {
      body: { username: ADMIN1, password: 'wrong' },
    });
    check('错密码 → 401', bad.status === 401, bad);

    const ok1 = await call('POST', '/api/admin/v1/auth/login', {
      body: { username: ADMIN1, password: ADMIN_PW },
    });
    check('登录 → 200', ok1.status === 200, ok1);
    const session1 = ok1.setCookie?.split(';').find((c) => c.startsWith('cb_admin_session='));
    check('种下 cb_admin_session', Boolean(session1));

    console.log('[4] 只读列表（flags 范围）');
    const users1 = await call('GET', '/users', { cookie: session1 });
    check('/users → 200', users1.status === 200, users1.status);
    check('渲染出 G 分组客户', users1.text.includes(MEMBER_G));
    check('不渲染 H 分组客户', !users1.text.includes(MEMBER_H));
    check(
      '范围徽标显示分组',
      users1.text.includes('仅分组 G'),
      /仅分组.{0,60}/u.exec(users1.text)?.[0] ?? '页面无「仅分组」字样',
    );
    const search = await call('GET', `/users?q=${MEMBER_G}`, { cookie: session1 });
    check('q 搜索命中 G 客户', search.status === 200 && search.text.includes(MEMBER_G));

    console.log('[5] view-all 管理员');
    const ok2 = await call('POST', '/api/admin/v1/auth/login', {
      body: { username: ADMIN2, password: ADMIN_PW },
    });
    const session2 = ok2.setCookie?.split(';').find((c) => c.startsWith('cb_admin_session='));
    const users2 = await call('GET', '/users', { cookie: session2 });
    check(
      'view-all 渲染两个分组的客户',
      users2.status === 200 && users2.text.includes(MEMBER_G) && users2.text.includes(MEMBER_H),
      users2.status,
    );
    check('范围徽标显示全部客户', users2.text.includes('全部客户'));

    console.log('[6] 登出 + 篡改 cookie');
    const logout = await call('POST', '/api/admin/v1/auth/logout', { cookie: session1 });
    check(
      '登出 → 200 + 清 cookie',
      logout.status === 200 && /cb_admin_session=;/.test(logout.setCookie ?? ''),
      logout.setCookie,
    );
    const tampered = await call('GET', '/users', {
      cookie: 'cb_admin_session=evil.token.here',
      follow: false,
    });
    check(
      '篡改 cookie → 重定向 /login',
      tampered.status >= 300 && tampered.status < 400,
      tampered.status,
    );
  } finally {
    server.kill();
    // Windows 下 shell 包装进程 kill 不彻底——落库级清理足够（scratch 是一次性库）
    await dropScratch().catch(() => undefined);
    try {
      rmSync('.next/cache', { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }

  console.log(`\n${passed} PASS / ${failed} FAIL`);
  if (failed > 0) {
    // 失败时带出服务日志尾部，便于定位服务端异常（如 i18n messages 加载问题）
    console.log('--- server log tail ---');
    console.log(serverLog.join('').slice(-2000));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => legacyPrisma.$disconnect());
