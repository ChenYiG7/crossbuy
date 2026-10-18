import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import {
  envelopeFail,
  envelopeOk,
  memberLoginSchema,
  type MemberProfile,
} from '@crossbuy/contract';
import { getWebConfig } from '@/config';
import { signMemberToken } from '@/auth/jwt';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@/auth/cookies';
import { getMemberService } from '@/server/member';
import { httpStatusForMemberError } from '@/server/http-status';

/**
 * POST /api/customer/v1/auth/login —— 会员登录（M1 客户面）。
 *
 * 规则复现旧 LoginMutation（限流/MD5/state 三闸/登录限制），会话形态换新：
 * 成功 → 种 HttpOnly JWT cookie + 返回 profile（旧系统登录后另查 getUserInfo）。
 * 旧 pc 登录的验证码要求未复现（新 REST 面先以限流兜底）——TODO 登记后续。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(envelopeFail(400, '请求体不是合法 JSON', traceId), { status: 400 });
  }

  // HTTP 边界先过契约（service 内会再校验一次——域边界不信任上游）
  const parsed = memberLoginSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return NextResponse.json(
      envelopeFail(
        400,
        `字段 ${field} 校验失败：${parsed.error.issues[0]?.message ?? ''}`,
        traceId,
      ),
      { status: 400 },
    );
  }

  const result = await getMemberService().login(parsed.data);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  const { uid, isDf, profile } = result.value;
  const config = getWebConfig();
  const ttl = parsed.data.rememberMe
    ? config.AUTH_SESSION_REMEMBER_TTL_SEC
    : config.AUTH_SESSION_TTL_SEC;
  const token = await signMemberToken(uid, isDf, ttl);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(ttl));

  return NextResponse.json(envelopeOk(profile satisfies MemberProfile, traceId));
}
