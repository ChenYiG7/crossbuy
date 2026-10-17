import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { envelopeFail, envelopeOk, type MemberProfile } from '@crossbuy/contract';
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

/**
 * GET /api/customer/v1/member/me —— 当前登录会员的资料（旧 getUserInfo 的 REST 化）。
 *
 * 跨域字段（未读消息/留言/邮件订阅/业务员）随属主域落地补齐——别域数据禁直连表。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const token = extractToken(request);
  if (!token) {
    return NextResponse.json(envelopeFail(401, '未登录', traceId), { status: 401 });
  }

  const verified = await getMemberVerifier().verify(token);
  if (!verified.ok) {
    return NextResponse.json(envelopeFail(401, verified.error.message, traceId), { status: 401 });
  }

  const result = await getMemberService().getProfile(verified.value);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  return NextResponse.json(envelopeOk(result.value satisfies MemberProfile, traceId));
}
