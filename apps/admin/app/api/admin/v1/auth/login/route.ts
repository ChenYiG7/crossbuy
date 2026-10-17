import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { adminLoginSchema, envelopeFail, envelopeOk, type AdminProfile } from '@crossbuy/contract';
import { getAdminConfig } from '@/config';
import { signAdminToken } from '@/auth/jwt';
import { ADMIN_SESSION_COOKIE_NAME, sessionCookieOptions } from '@/auth/cookies';
import { getAdminService } from '@/server/container';
import { httpStatusForAdminError } from '@/server/http-status';

/**
 * POST /api/admin/v1/auth/login —— 后台登录（M1 §四-4，替代旧 dcat AuthController）。
 *
 * 规则复现：bcrypt 校验（AdminUser::Hash::check）+ 软删拒登；三者同一错误（禁枚举）。
 * 无登录限流（旧 dcat 默认无 throttle——差异点已在 admin service 注释登记）。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(envelopeFail(400, '请求体不是合法 JSON', traceId), { status: 400 });
  }

  const parsed = adminLoginSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return NextResponse.json(
      envelopeFail(400, `字段 ${field} 校验失败：${parsed.error.issues[0]?.message ?? ''}`, traceId),
      { status: 400 },
    );
  }

  const result = await getAdminService().login(parsed.data);
  if (!result.ok) {
    const status = httpStatusForAdminError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  const ttl = getAdminConfig().AUTH_SESSION_TTL_SEC;
  const token = await signAdminToken(result.value.id, ttl);
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_SESSION_COOKIE_NAME, token, sessionCookieOptions(ttl));

  return NextResponse.json(envelopeOk(result.value satisfies AdminProfile, traceId));
}
