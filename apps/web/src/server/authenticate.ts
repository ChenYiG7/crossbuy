import type { NextRequest } from 'next/server';
import type { Principal } from '@crossbuy/auth';
import { envelopeFail } from '@crossbuy/contract';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/auth/cookies';
import { getMemberVerifier } from '@/server/member';

/**
 * 客户面认证公共步（login/me/favorites 路由共用）：
 * cookie（web）或 Authorization: Bearer（app 客户端）→ 原始 token → Principal。
 * 失败直接返回 401 响应（调用方原样返回）；成功返回 { principal }。
 */
export function extractToken(request: NextRequest): string | null {
  const fromCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (fromCookie) return fromCookie;
  const authorization = request.headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return null;
}

export async function authenticate(
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
