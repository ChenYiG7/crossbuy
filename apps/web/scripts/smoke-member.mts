/**
 * apps/web 会员链路端到端演练（M1；docs/06 步骤 6「写路径演练」的 HTTP 面缩小版）。
 *
 * 与域单测的分工：单测证明**规则**对（连真实 dump 库、事务回滚）；
 * 本脚本证明**链路**通——路由 → JWT 签发 → cookie → 校验 → RSC 渲染整条闭环，
 *   以及未登录/错密码/不存在用户/登出/篡改 cookie 各分支的 HTTP 表现。
 *
 * 数据隔离：自建 scratch 库 `crossbuy_e2e`（结构与 dump 同构 + 一个夹具用户），
 *   跑完即 DROP——**不碰 dump 库**（成员域 vitest 也不碰，两边互不污染）。
 *
 * 前置：`pnpm build`（next start 需要生产构建）。
 * 用法：pnpm --filter @crossbuy/web smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

// 凭据口径与成员域 vitest 一致（TEST_DATABASE_URL 优先，缺省本机 dump 库）；
// 必须在动态 import @crossbuy/db **之前**设置（ESM import 提升会抢跑）。
process.env.DATABASE_URL ??= 'mysql://root:root@127.0.0.1:3306/taotaro';

const { legacyPrisma } = await import('@crossbuy/db');

const SCRATCH_DB = 'crossbuy_e2e';
const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'e2e-smoke-secret';
const FIXTURE = { uname: 'e2e-smoke', password: 'e2e-pass' };

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

async function setupScratch(): Promise<void> {
  await legacyPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await legacyPrisma.$executeRawUnsafe(
    `CREATE DATABASE ${SCRATCH_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
  );
  await legacyPrisma.$executeRawUnsafe(`CREATE TABLE ${SCRATCH_DB}.dg_users LIKE taotaro.dg_users`);
  const pwd = createHash('md5').update(FIXTURE.password, 'utf8').digest('hex');
  // 内联 SQL：值全部是脚本内的受控常量（夹具账号/密码哈希），无外部输入，无注入面
  await legacyPrisma.$executeRawUnsafe(
    `INSERT INTO ${SCRATCH_DB}.dg_users
       (uname, password, card, validity, email, tname, money, usetype, dfflag, state, orderenable, reg_extra)
     VALUES ('${FIXTURE.uname}', '${pwd}', 'e2e', 1, 'e2e-smoke@example.com', '演练用户',
             123.45, 2, 1, 1, 1, '{"useInquiry":true}')`,
  );
}

async function dropScratch(): Promise<void> {
  await legacyPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
}

function startServer(): ChildProcess {
  return spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
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
      const res = await fetch(`${BASE}/api/customer/v1/member/me`);
      if (res.status === 401) return true; // 未登录 401 = 服务已就绪
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

interface Res {
  status: number;
  body: { code: number; message: string; data: Record<string, unknown> | null; traceId: string };
  setCookie: string | null;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    body: (await res.json()) as Res['body'],
    setCookie,
  };
}

function sessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const pair = setCookie.split(';')[0];
  return pair?.startsWith('cb_session=') ? pair : null;
}

async function main(): Promise<void> {
  console.log('[0] 建 scratch 库 + 夹具用户');
  await setupScratch();

  const child = startServer();
  const serverLog: string[] = [];
  child.stdout?.on('data', (d: Buffer) => serverLog.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => serverLog.push(d.toString()));

  try {
    console.log('[1] 启动 next start 并等待就绪');
    const ready = await waitReady(child);
    check('服务就绪（/member/me 返回 401）', ready);
    if (!ready) {
      console.log(serverLog.join('').slice(-2000));
      return;
    }

    console.log('[2] 未登录 / 错密码 / 不存在用户');
    const anon = await call('GET', '/api/customer/v1/member/me');
    check('未登录 GET me → 401', anon.status === 401 && anon.body.code === 401, anon.body);
    check('未登录 me → 有 traceId', typeof anon.body.traceId === 'string' && anon.body.traceId.length > 0);

    const wrongPwd = await call('POST', '/api/customer/v1/auth/login', {
      body: { username: FIXTURE.uname, password: 'wrong' },
    });
    check('错密码 → 401 MEMBER_LOGIN_FAILED', wrongPwd.status === 401 && wrongPwd.body.code === 401, wrongPwd.body);

    const noUser = await call('POST', '/api/customer/v1/auth/login', {
      body: { username: 'no-such-e2e-user', password: 'x' },
    });
    check('不存在用户 → 与错密码同一 401（禁枚举）', noUser.status === 401, noUser.body);

    console.log('[3] 登录成功 → cookie + profile');
    const login = await call('POST', '/api/customer/v1/auth/login', {
      body: { username: FIXTURE.uname, password: FIXTURE.password },
    });
    check('登录 → 200', login.status === 200 && login.body.code === 0, login.body);
    check('profile.uname 正确', login.body.data?.uname === FIXTURE.uname);
    check('profile.money = "123.45"（Decimal 字符串）', login.body.data?.money === '123.45');
    check('profile.useType = 2（枚举保真）', login.body.data?.useType === 2);
    check('profile.dfFlag = true', login.body.data?.dfFlag === true);
    check('profile.useInquiry = true（reg_extra JSON）', login.body.data?.useInquiry === true);

    const cookie = sessionCookie(login.setCookie);
    check('响应种下 cb_session（HttpOnly）', cookie !== null && /HttpOnly/i.test(login.setCookie ?? ''), login.setCookie);

    console.log('[4] 带 cookie / Bearer 读 me');
    const me = await call('GET', '/api/customer/v1/member/me', { cookie: cookie ?? undefined });
    check('cookie GET me → 200', me.status === 200 && me.body.data?.uname === FIXTURE.uname, me.body);

    const token = cookie?.split('=')[1] ?? '';
    const bearer = await call('GET', '/api/customer/v1/member/me', { bearer: token });
    check('Bearer GET me → 200', bearer.status === 200, bearer.body);

    console.log('[5] RSC 会员页');
    const page = await fetch(`${BASE}/member`, { headers: { cookie: cookie ?? '' } });
    const html = await page.text();
    check('会员页 → 200', page.status === 200);
    check('会员页渲染出资料（RSC 直调）', html.includes('演练用户') && html.includes('123.45'));
    const anonPage = await fetch(`${BASE}/member`);
    const anonHtml = await anonPage.text();
    check('未登录访问会员页 → 登录表单', anonHtml.includes('账号（邮箱或用户名）'));

    console.log('[6] 登出 + 篡改 cookie');
    const logout = await call('POST', '/api/customer/v1/auth/logout', { cookie: cookie ?? undefined });
    check('登出 → 200', logout.status === 200);
    // 登出 = 清 cookie（Set-Cookie 空值 + Max-Age=0）。JWT 无状态，已签发 token 在
    // TTL 内仍有效是**固有性质**（logout 路由注释已声明；即时失效需 Redis 黑名单，
    // 随基建落地）——把该性质锁为显式断言：将来上了黑名单，这条会红，逼一次有意识更新。
    check(
      '登出响应清 cookie（cb_session 空值 + Max-Age=0）',
      /cb_session=/.test(logout.setCookie ?? '') && /Max-Age=0/i.test(logout.setCookie ?? ''),
      logout.setCookie,
    );
    const noCookie = await call('GET', '/api/customer/v1/member/me');
    check('登出后无 cookie → 401', noCookie.status === 401, noCookie.body);
    const afterLogout = await call('GET', '/api/customer/v1/member/me', { cookie: cookie ?? undefined });
    check('旧 token TTL 内仍有效（无状态固有性质）', afterLogout.status === 200, afterLogout.body);

    const tampered = await call('GET', '/api/customer/v1/member/me', {
      cookie: `cb_session=${token.slice(0, -3)}aaa`,
    });
    check('篡改 cookie → 401', tampered.status === 401, tampered.body);

    const malformed = await call('GET', '/api/customer/v1/member/me', { cookie: 'cb_session=not-a-jwt' });
    check('非法 JWT → 401', malformed.status === 401);
  } finally {
    child.kill();
    await dropScratch();
    await legacyPrisma.$disconnect();
  }

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
