import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { envelopeFail, envelopeOk } from '@crossbuy/contract';
import { ADMIN_SESSION_COOKIE_NAME, sessionCookieOptions } from '@/auth/cookies';

/**
 * POST /api/admin/v1/auth/logout —— 后台登出 = 清 cookie。
 *
 * JWT 无状态：旧 token 在 TTL 内仍有效是固有性质（同会员端，见 web smoke
 * 显式锁死断言）。后台会话黑名单/强制下线随 R3 认证中心。
 */
export async function POST(): Promise<NextResponse> {
  const traceId = randomUUID();
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(0), maxAge: 0 });
  return NextResponse.json(envelopeOk(undefined, traceId));
}
