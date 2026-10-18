import { errors, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';

/**
 * 后台会话校验（apps/api 侧最小实现）。
 *
 * chrome 插件回传走的是**后台登录态**（旧 `Admin::user()` 从 `x-laravel-session` 解出），
 * 新系统在机器面按 admin JWT 校验：Bearer 头优先，其次 `cb_admin_session` cookie
 * （插件跑在浏览器里，cookie 自动带；非浏览器场景可用 Bearer）。
 *
 * ⚠ 与 `apps/admin/src/auth/jwt.ts` 是同一套载荷（sub=adminId / kind='admin'）的**两份实现**：
 * 认证中心（R3）会把它们收进 `@crossbuy/auth`；R1 阶段先按「薄壳各自装配」处理，
 * 密钥同源（AUTH_SESSION_SECRET），不存在两套令牌。
 */
const DEV_FALLBACK_SECRET = 'dev-only-insecure-admin-secret-do-not-use-in-prod';

export const ADMIN_SESSION_COOKIE_NAME = 'cb_admin_session';

export function adminSessionSecret(configured: string | undefined): Uint8Array {
  if (configured) return new TextEncoder().encode(configured);
  return new TextEncoder().encode(DEV_FALLBACK_SECRET);
}

function readToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth))
    return auth.replace(/^Bearer\s+/i, '').trim();
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === ADMIN_SESSION_COOKIE_NAME) return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

/** 校验后台会话 → adminId；无效/过期/形态不对一律 null（上层统一 401） */
export async function resolveAdminId(
  req: FastifyRequest,
  secret: string | undefined,
): Promise<number | null> {
  const token = readToken(req);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, adminSessionSecret(secret));
    if (payload.kind !== 'admin') return null;
    const adminId = Number(payload.sub);
    return Number.isInteger(adminId) && adminId > 0 ? adminId : null;
  } catch (e) {
    void (e instanceof errors.JWTExpired);
    return null;
  }
}
