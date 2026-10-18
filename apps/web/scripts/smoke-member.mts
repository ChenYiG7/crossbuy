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
  await legacyPrisma.$executeRawUnsafe(
    `CREATE TABLE ${SCRATCH_DB}.dg_favorite LIKE taotaro.dg_favorite`,
  );
  // 加购链路（旧 AddCartMutation）：dg_cart + v2_supplier_product（后者经 purchase 域端口写）
  await legacyPrisma.$executeRawUnsafe(`CREATE TABLE ${SCRATCH_DB}.dg_cart LIKE taotaro.dg_cart`);
  await legacyPrisma.$executeRawUnsafe(
    `CREATE TABLE ${SCRATCH_DB}.v2_supplier_product LIKE taotaro.v2_supplier_product`,
  );
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
  // 非 JSON 响应（未捕获 500 常是空 body）不许把演练炸掉——带上下文落到 body.message，
  // 让断言失败信息能指认服务端出了什么事（2026-10-17 收藏首跑就是这样定位的）
  const text = await res.text();
  let body: Res['body'];
  try {
    body = JSON.parse(text) as Res['body'];
  } catch {
    body = {
      code: -1,
      message: `非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 300) || '<empty body>'}`,
      data: null,
      traceId: '',
    };
  }
  return { status: res.status, body, setCookie };
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
    check(
      '未登录 me → 有 traceId',
      typeof anon.body.traceId === 'string' && anon.body.traceId.length > 0,
    );

    const wrongPwd = await call('POST', '/api/customer/v1/auth/login', {
      body: { username: FIXTURE.uname, password: 'wrong' },
    });
    check(
      '错密码 → 401 MEMBER_LOGIN_FAILED',
      wrongPwd.status === 401 && wrongPwd.body.code === 401,
      wrongPwd.body,
    );

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
    check(
      '响应种下 cb_session（HttpOnly）',
      cookie !== null && /HttpOnly/i.test(login.setCookie ?? ''),
      login.setCookie,
    );

    console.log('[4] 带 cookie / Bearer 读 me');
    const me = await call('GET', '/api/customer/v1/member/me', { cookie: cookie ?? undefined });

    console.log('[4.5] 资料编辑 PATCH（旧 EditUserInfo REST 化）');
    const patched = await call('PATCH', '/api/customer/v1/member/me', {
      cookie: cookie ?? undefined,
      body: { trueName: '演练用户改名', tel: '090-0000-0000', useType: 3 },
    });
    check('PATCH → 200', patched.status === 200, patched.body);
    check(
      'PATCH 响应即最新 profile（trueName 已改）',
      patched.body.data?.trueName === '演练用户改名',
    );
    const afterPatch = await call('GET', '/api/customer/v1/member/me', {
      cookie: cookie ?? undefined,
    });
    check(
      '重读 me → 改动已落库',
      afterPatch.body.data?.trueName === '演练用户改名' && afterPatch.body.data?.useType === 3,
    );
    const anonPatch = await call('PATCH', '/api/customer/v1/member/me', {
      body: { trueName: 'x' },
    });
    check('未登录 PATCH → 401', anonPatch.status === 401);
    const badPatch = await call('PATCH', '/api/customer/v1/member/me', {
      cookie: cookie ?? undefined,
      body: { useType: 9 },
    });
    check(
      '越界枚举 PATCH → 400（契约拒绝）',
      badPatch.status === 400 && badPatch.body.code === 400,
      badPatch.body,
    );

    console.log('[4.6] 收藏增删（旧 AddFavorite/DeleteFavorite/ListFavorite REST 化）');
    // 夹具用户 dfflag=1 ⇒ 收藏落 type=3（代发）——默认页签（非代发）看不见它，正好验证二值过滤
    const favCreate = await call('POST', '/api/customer/v1/favorites', {
      cookie: cookie ?? undefined,
      body: {
        name: '冒烟测试商品',
        platform: 'taobao',
        nick: '冒烟商家',
        price: 19.8,
        detailUrl: 'https://item.taobao.com/item.htm?id=694784194003',
        picture: 'http://img.alicdd.com/x.jpg',
      },
    });
    check('新增收藏 → 200', favCreate.status === 200, favCreate.body);
    const fid = (favCreate.body.data as { fid?: number } | null)?.fid;
    check('返回 fid', typeof fid === 'number' && fid > 0);
    check(
      'type=3（夹具用户 dfflag=1）',
      (favCreate.body.data as { type?: number } | null)?.type === 3,
    );
    check(
      'goodssite=淘宝',
      (favCreate.body.data as { goodsSite?: string } | null)?.goodsSite === '淘宝',
    );
    check(
      'goodsPrice 字符串（禁浮点）',
      (favCreate.body.data as { goodsPrice?: string } | null)?.goodsPrice === '19.8',
    );
    check(
      'createdAt ISO +08:00',
      /^\d{4}-\d{2}-\d{2}T[\d:]{8}\+08:00$/.test(
        (favCreate.body.data as { createdAt?: string } | null)?.createdAt ?? '',
      ),
    );

    const favDefault = await call('GET', '/api/customer/v1/favorites', {
      cookie: cookie ?? undefined,
    });
    check(
      '默认列表不含代发收藏（二值过滤）',
      (favDefault.body.data?.items ?? []).every((f: { fid: number }) => f.fid !== fid),
    );
    const favDaifa = await call('GET', '/api/customer/v1/favorites?type=3', {
      cookie: cookie ?? undefined,
    });
    check(
      'type=3 列表含该收藏',
      (favDaifa.body.data?.items ?? []).some((f: { fid: number }) => f.fid === fid),
    );

    const favDup = await call('POST', '/api/customer/v1/favorites', {
      cookie: cookie ?? undefined,
      body: {
        name: '冒烟测试商品',
        platform: 'taobao',
        nick: '冒烟商家',
        price: 19.8,
        detailUrl: 'https://item.taobao.com/item.htm?id=694784194003',
      },
    });
    check('重复 URL → 409', favDup.status === 409, favDup.body);

    const favDel = await call('DELETE', `/api/customer/v1/favorites/${fid}`, {
      cookie: cookie ?? undefined,
    });
    check('删除收藏 → 200', favDel.status === 200);
    const favDelAgain = await call('DELETE', `/api/customer/v1/favorites/${fid}`, {
      cookie: cookie ?? undefined,
    });
    check('重复删除 → 404 not_found', favDelAgain.status === 404, favDelAgain.body);
    const favAnon = await call('POST', '/api/customer/v1/favorites', {
      body: { name: 'x', platform: 'taobao', nick: 'x', price: 1, detailUrl: 'https://e.com/1' },
    });
    check('未登录新增收藏 → 401', favAnon.status === 401);
    check(
      'cookie GET me → 200',
      me.status === 200 && me.body.data?.uname === FIXTURE.uname,
      me.body,
    );

    const token = cookie?.split('=')[1] ?? '';
    const bearer = await call('GET', '/api/customer/v1/member/me', { bearer: token });
    check('Bearer GET me → 200', bearer.status === 200, bearer.body);

    console.log('[4.7] 加购（旧 addCart GraphQL → POST /api/customer/v1/carts）');
    const cartAnon = await call('POST', '/api/customer/v1/carts', {
      body: { goodsList: [{ platform: 'taobao', title: 'x', quantity: 1 }] },
    });
    check('未登录加购 → 401', cartAnon.status === 401, cartAnon.body);

    const cartNoList = await call('POST', '/api/customer/v1/carts', {
      cookie: cookie ?? undefined,
      body: {},
    });
    check(
      '缺 goodsList → 400 CART_GOODS_LIST_REQUIRED',
      cartNoList.status === 400 && cartNoList.body.message === 'goodsList is required',
      cartNoList.body,
    );

    const cartAdd = await call('POST', '/api/customer/v1/carts', {
      cookie: cookie ?? undefined,
      body: {
        goodsList: [
          {
            platform: 'taobao',
            url: 'https://item.taobao.com/item.htm?id=694784194003',
            title: '演练加购商品',
            shopNick: '演练商家',
            price: 88.5,
            quantity: 3,
            props: [{ name: '色', value: '赤' }],
            addFrom: 1,
          },
        ],
        returnCartId: true,
      },
    });
    check('加购 → 200', cartAdd.status === 200, cartAdd.body);
    const cartData = cartAdd.body.data as { result?: string; cartIds?: number[] } | null;
    check('returnCartId → result 为 gid 串', /^\d+$/.test(cartData?.result ?? ''), cartData);
    check('cartIds 返回 1 个', cartData?.cartIds?.length === 1);

    // 直查 scratch 库核对落库列（不依赖列表接口，避免与列表切片互相耦合）
    const rows = await legacyPrisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT type, goodssite, goodsid, goodsprice, goodsnum, uname, sku_name, add_from, yanhuofba
         FROM ${SCRATCH_DB}.dg_cart WHERE uname = '${FIXTURE.uname}'`,
    );
    check('落库 1 行', rows.length === 1, rows);
    // 夹具用户 dfflag=1 ⇒ 代发(3)；goodsid 由 URL 正则兜底解析（S39）
    check('type=3（夹具 dfflag=1 → 代发）', rows[0]?.['type'] === 3, rows[0]);
    check(
      'goodssite=淘宝 / goodsid 已解析',
      rows[0]?.['goodssite'] === '淘宝' && String(rows[0]?.['goodsid']) === '694784194003',
      rows[0],
    );
    check(
      'goodsprice=88.5 / goodsnum=3',
      Number(rows[0]?.['goodsprice']) === 88.5 && Number(rows[0]?.['goodsnum']) === 3,
      rows[0],
    );
    check(
      'uname 取会员当前值（S37 冗余列）',
      String(rows[0]?.['uname']) === FIXTURE.uname,
      rows[0],
    );
    check(
      'sku_name 为旧 HTML 串',
      String(rows[0]?.['sku_name']) === '<font color=red>色:</font><font color=green> 赤 </font>',
      rows[0],
    );
    check('add_from=1 原样落库', Number(rows[0]?.['add_from']) === 1, rows[0]);
    check('yanhuofba 未传 → 落空串（S43）', rows[0]?.['yanhuofba'] === '', rows[0]);

    const cartZhuan = await call('POST', '/api/customer/v1/carts', {
      cookie: cookie ?? undefined,
      body: {
        goodsList: [
          {
            platform: 'transshipment',
            title: '转运品',
            quantity: 1,
            sendPrice: 42.5,
            expressNo: 'EX1',
          },
        ],
      },
    });
    check(
      '转运加购 → 200 且 result=done',
      cartZhuan.status === 200 &&
        (cartZhuan.body.data as { result?: string } | null)?.result === 'done',
      cartZhuan.body,
    );
    const zhuanRows = await legacyPrisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT type, siteurl, goodsseller, sendprice FROM ${SCRATCH_DB}.dg_cart
         WHERE uname = '${FIXTURE.uname}' AND goodssite = '転送サービス'`,
    );
    check(
      '转运行 type=2 / siteurl=### / goodsseller 默认 shipforme',
      zhuanRows[0]?.['type'] === 2 &&
        zhuanRows[0]?.['siteurl'] === '###' &&
        zhuanRows[0]?.['goodsseller'] === 'shipforme',
      zhuanRows[0],
    );

    const cartValidate = await call('POST', '/api/customer/v1/carts', {
      cookie: cookie ?? undefined,
      body: { goodsList: [{ platform: 'taobao', title: 'x', quantity: 1 }], isValidate: 1 },
    });
    check(
      'isValidate=1 → 空串短路（旧怪癖）',
      (cartValidate.body.data as { result?: string } | null)?.result === '',
      cartValidate.body,
    );
    const afterValidate = await legacyPrisma.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*) AS c FROM ${SCRATCH_DB}.dg_cart WHERE uname = '${FIXTURE.uname}'`,
    );
    check('isValidate=1 不落库', Number(afterValidate[0]?.['c'] ?? 0) === 2, afterValidate[0]);

    console.log('[5] RSC 会员页');
    const page = await fetch(`${BASE}/member`, { headers: { cookie: cookie ?? '' } });
    const html = await page.text();
    check('会员页 → 200', page.status === 200);
    check('会员页渲染出资料（RSC 直调）', html.includes('演练用户') && html.includes('123.45'));
    const anonPage = await fetch(`${BASE}/member`);
    const anonHtml = await anonPage.text();
    check('未登录访问会员页 → 登录表单', anonHtml.includes('账号（邮箱或用户名）'));

    console.log('[6] 登出 + 篡改 cookie');
    const logout = await call('POST', '/api/customer/v1/auth/logout', {
      cookie: cookie ?? undefined,
    });
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
    const afterLogout = await call('GET', '/api/customer/v1/member/me', {
      cookie: cookie ?? undefined,
    });
    check('旧 token TTL 内仍有效（无状态固有性质）', afterLogout.status === 200, afterLogout.body);

    const tampered = await call('GET', '/api/customer/v1/member/me', {
      cookie: `cb_session=${token.slice(0, -3)}aaa`,
    });
    check('篡改 cookie → 401', tampered.status === 401, tampered.body);

    const malformed = await call('GET', '/api/customer/v1/member/me', {
      cookie: 'cb_session=not-a-jwt',
    });
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
