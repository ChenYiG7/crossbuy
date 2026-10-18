/**
 * apps/api 冒烟验收（docs/06 任务 0.4）：
 *   ① `/api/open/v1/health` + `/api/webhook/v1/health` 跑通且带 traceId
 *   ② OpenAPI 文档由 zod 生成，含开放面路径
 *   ③ **守卫有效性**（不看绿、看它拦没拦住）：无签名 401 / 错签名 401 /
 *      正确签名 200 / IP 不在白名单 403 / production 缺密钥 503
 *
 * 用法：pnpm --filter @crossbuy/api smoke
 */
import { createHmac } from 'node:crypto';
import { SignJWT } from 'jose';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';

const SECRET = 'smoke-secret';
const BASE = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'error',
  API_OPEN_HMAC_SECRET: SECRET,
  API_OPEN_IP_ALLOWLIST: '',
} as const;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

function sign(ts: number, method: string, url: string, body = ''): string {
  return createHmac('sha256', SECRET)
    .update(`${ts}\n${method}\n${url}\n${body}`)
    .digest('hex');
}

async function main(): Promise<void> {
  console.log('[1] 健康路由 + traceId');
  {
    const app = await buildApp(loadConfig({ ...BASE } as NodeJS.ProcessEnv));
    for (const url of ['/api/open/v1/health', '/api/webhook/v1/health']) {
      const res = await app.inject({ method: 'GET', url });
      const body = res.json<{ code: number; data: { status: string } | null; traceId: string }>();
      check(`${url} → 200`, res.statusCode === 200, res.statusCode);
      check(`${url} → code=0`, body.code === 0, body);
      check(`${url} → data.status=ok`, body.data?.status === 'ok', body.data);
      check(`${url} → 带 traceId`, typeof body.traceId === 'string' && body.traceId.length > 0, body.traceId);
    }
    // traceId 入参透传（上游链路能串起来）
    const res = await app.inject({
      method: 'GET',
      url: '/api/open/v1/health',
      headers: { 'x-trace-id': 'trace-from-upstream' },
    });
    check('入参 X-Trace-Id 被透传', res.json<{ traceId: string }>().traceId === 'trace-from-upstream');
    await app.close();
  }

  console.log('[2] OpenAPI（zod → 文档）');
  {
    const app = await buildApp(loadConfig({ ...BASE } as NodeJS.ProcessEnv));
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    const doc = res.json<{ paths: Record<string, unknown> }>();
    check('/docs/json → 200', res.statusCode === 200, res.statusCode);
    check('文档含 /api/open/v1/ping', '/api/open/v1/ping' in doc.paths, Object.keys(doc.paths));
    check('文档含 /api/open/v1/health', '/api/open/v1/health' in doc.paths);
    await app.close();
  }

  console.log('[3] 守卫有效性（必须拦住）');
  {
    const app = await buildApp(loadConfig({ ...BASE } as NodeJS.ProcessEnv));
    const url = '/api/open/v1/ping';

    const noSig = await app.inject({ method: 'GET', url });
    check('无签名头 → 401', noSig.statusCode === 401, noSig.statusCode);

    const badSig = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-timestamp': String(Math.floor(Date.now() / 1000)), 'x-signature': 'deadbeef' },
    });
    check('错误签名 → 401', badSig.statusCode === 401, badSig.statusCode);

    const stale = Math.floor(Date.now() / 1000) - 100_000;
    const staleRes = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-timestamp': String(stale), 'x-signature': sign(stale, 'GET', url) },
    });
    check('超窗时间戳（防重放）→ 401', staleRes.statusCode === 401, staleRes.statusCode);

    const ts = Math.floor(Date.now() / 1000);
    const okRes = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-timestamp': String(ts), 'x-signature': sign(ts, 'GET', url) },
    });
    check('正确签名 → 200', okRes.statusCode === 200, okRes.statusCode);
    check('正确签名 → data.pong=true', okRes.json<{ data: { pong: boolean } }>().data?.pong === true);

    // 签名含 body：POST 篡改 body 必须失效（GET 带 body 不解析，验证不了这点）
    const echoUrl = '/api/open/v1/echo';
    const signed = JSON.stringify({ text: 'hello' });
    const ts2 = Math.floor(Date.now() / 1000);
    const okEcho = await app.inject({
      method: 'POST',
      url: echoUrl,
      payload: signed,
      headers: {
        'content-type': 'application/json',
        'x-timestamp': String(ts2),
        'x-signature': sign(ts2, 'POST', echoUrl, signed),
      },
    });
    check('POST 正确签名（含 body）→ 200', okEcho.statusCode === 200, okEcho.statusCode);
    check('POST 回显内容正确', okEcho.json<{ data: { echo: string } }>().data?.echo === 'hello');

    const tampered = await app.inject({
      method: 'POST',
      url: echoUrl,
      payload: JSON.stringify({ text: 'evil' }),
      headers: {
        'content-type': 'application/json',
        'x-timestamp': String(ts2),
        'x-signature': sign(ts2, 'POST', echoUrl, signed), // 用原 body 的签名
      },
    });
    check('body 参与签名（篡改后失效）→ 401', tampered.statusCode === 401, tampered.statusCode);
    await app.close();
  }

  console.log('[4] IP 白名单');
  {
    const app = await buildApp(
      loadConfig({ ...BASE, API_OPEN_IP_ALLOWLIST: '203.0.113.0/24, 198.51.100.7' } as NodeJS.ProcessEnv),
    );
    const ts = Math.floor(Date.now() / 1000);
    const headers = { 'x-timestamp': String(ts), 'x-signature': sign(ts, 'GET', '/api/open/v1/ping') };

    const denied = await app.inject({ method: 'GET', url: '/api/open/v1/ping', remoteAddress: '1.2.3.4', headers });
    check('白名单外 IP → 403', denied.statusCode === 403, denied.statusCode);

    const allowedCidr = await app.inject({
      method: 'GET',
      url: '/api/open/v1/ping',
      remoteAddress: '203.0.113.55',
      headers,
    });
    check('CIDR 命中（203.0.113.0/24）→ 200', allowedCidr.statusCode === 200, allowedCidr.statusCode);

    const allowedExact = await app.inject({
      method: 'GET',
      url: '/api/open/v1/ping',
      remoteAddress: '198.51.100.7',
      headers,
    });
    check('精确 IP 命中 → 200', allowedExact.statusCode === 200, allowedExact.statusCode);
    await app.close();
  }

  console.log('[5] production 缺密钥 = 鉴权不可用（503，不是放行）');
  {
    const app = await buildApp(
      loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: 'error',
        API_OPEN_IP_ALLOWLIST: '',
      } as unknown as NodeJS.ProcessEnv),
    );
    const res = await app.inject({ method: 'GET', url: '/api/open/v1/ping' });
    check('production 无密钥 → 503', res.statusCode === 503, res.statusCode);
    await app.close();
  }

  console.log('[6] chrome 回传（后台登录态鉴权 + 契约）');
  {
    const app = await buildApp(loadConfig({ ...BASE, AUTH_SESSION_SECRET: 'smoke-admin-secret' } as NodeJS.ProcessEnv));

    // 文档登记（新路由必须出现在 OpenAPI）
    const doc = (await app.inject({ method: 'GET', url: '/docs/json' })).json<{ paths: Record<string, unknown> }>();
    check('文档含 /api/webhook/v1/chrome', '/api/webhook/v1/chrome' in doc.paths, Object.keys(doc.paths));

    // 无凭证 / 错凭证 / 非 admin 令牌 → 401（不看绿，看它拦没拦住）
    const noAuth = await app.inject({ method: 'POST', url: '/api/webhook/v1/chrome', payload: { oids: '1', action: 1 } });
    check('chrome 无凭证 → 401', noAuth.statusCode === 401, noAuth.statusCode);

    const badAuth = await app.inject({
      method: 'POST',
      url: '/api/webhook/v1/chrome',
      payload: { oids: '1', action: 1 },
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    check('chrome 错凭证 → 401', badAuth.statusCode === 401, badAuth.statusCode);

    // 合法 JWT 但 kind != admin（会员令牌不能当后台令牌用）
    const memberToken = await new SignJWT({ kind: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('1')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(new TextEncoder().encode('smoke-admin-secret'));
    const wrongKind = await app.inject({
      method: 'POST',
      url: '/api/webhook/v1/chrome',
      payload: { oids: '1', action: 1 },
      headers: { authorization: `Bearer ${memberToken}` },
    });
    check('chrome 会员令牌 → 401（kind 判别）', wrongKind.statusCode === 401, wrongKind.statusCode);

    // 入参校验：action 必填（旧控制器无 action 会落到 wrong action 分支）
    const missingAction = await app.inject({
      method: 'POST',
      url: '/api/webhook/v1/chrome',
      payload: { oids: '1' },
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    // 契约校验（zod body）在 handler 之前 ⇒ 缺 action 直接被 400 拦住，不会进业务
    check('chrome 缺 action → 400（契约守卫，不放行）', missingAction.statusCode === 400, missingAction.statusCode);
    await app.close();
  }

  console.log(
    failures === 0
      ? '\napps/api 冒烟全部通过 ✅'
      : `\n${failures} 项失败 —— 守卫不可信，先修再谈交付。`,
  );
  if (failures > 0) process.exit(1);
}

void main();
