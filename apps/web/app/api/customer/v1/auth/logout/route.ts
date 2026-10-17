import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { envelopeOk } from '@crossbuy/contract';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@/auth/cookies';

/**
 * POST /api/customer/v1/auth/logout —— 登出（清会话 cookie）。
 *
 * JWT 无状态，服务端不存会话 ⇒ 「登出」= 清 cookie（已签发的 token 在 TTL 内仍有效，
 * 属无状态会话的固有性质；需要即时失效时上 Redis 黑名单，随基建落地再议）。
 */
export async function POST(): Promise<NextResponse> {
  const traceId = randomUUID();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, '', { ...sessionCookieOptions(0), maxAge: 0 });
  return NextResponse.json(envelopeOk(null, traceId));
}
