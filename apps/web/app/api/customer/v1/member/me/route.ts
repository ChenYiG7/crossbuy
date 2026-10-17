import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  envelopeFail,
  envelopeOk,
  memberProfileUpdateSchema,
  type MemberProfile,
} from '@crossbuy/contract';
import type { Principal } from '@crossbuy/auth';
import { SESSION_COOKIE_NAME } from '@/auth/cookies';
import { getMemberService, getMemberVerifier } from '@/server/member';
import { httpStatusForMemberError } from '@/server/http-status';

/** 从 cookie 或 Authorization: Bearer 取原始 token（web 用 cookie，app 客户端可用 Bearer） */
function extractToken(request: NextRequest): string | null {
  const fromCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (fromCookie) return fromCookie;
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return null;
}

/** 认证公共步：token → Principal；失败直接是 401 响应（调用方原样返回） */
async function authenticate(
  request: NextRequest,
  traceId: string,
): Promise<{ principal: Principal } | NextResponse> {
  const token = extractToken(request);
  if (!token) {
    return NextResponse.json(envelopeFail(401, '未登录', traceId), { status: 401 });
  }
  const verified = await getMemberVerifier().verify(token);
  if (!verified.ok) {
    return NextResponse.json(envelopeFail(401, verified.error.message, traceId), { status: 401 });
  }
  return { principal: verified.value };
}

/**
 * GET /api/customer/v1/member/me —— 当前登录会员的资料（旧 getUserInfo 的 REST 化）。
 *
 * 跨域字段（未读消息/留言/邮件订阅/业务员）随属主域落地补齐——别域数据禁直连表。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  const result = await getMemberService().getProfile(auth.principal);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  return NextResponse.json(envelopeOk(result.value satisfies MemberProfile, traceId));
}

/**
 * PATCH /api/customer/v1/member/me —— 资料编辑（旧 EditUserInfo 的 REST 化）。
 *
 * - HTTP 边界先过契约（service 内会再校验一次——域边界不信任上游）
 * - 写后重读返回最新 profile（旧 mutation 只回 'done'；REST 面回资源更实用，
 *   且与「改完立刻能看到效果」的页面流匹配——行为差异登记 docs/plans/08）
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(envelopeFail(400, '请求体不是合法 JSON', traceId), { status: 400 });
  }

  const parsed = memberProfileUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return NextResponse.json(
      envelopeFail(400, `字段 ${field} 校验失败：${parsed.error.issues[0]?.message ?? ''}`, traceId),
      { status: 400 },
    );
  }

  const updated = await getMemberService().updateProfile(auth.principal, parsed.data);
  if (!updated.ok) {
    const status = httpStatusForMemberError(updated.error.code);
    return NextResponse.json(envelopeFail(status, updated.error.message, traceId), { status });
  }

  const result = await getMemberService().getProfile(auth.principal);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }
  return NextResponse.json(envelopeOk(result.value satisfies MemberProfile, traceId));
}
