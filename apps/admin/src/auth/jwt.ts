import { errors, jwtVerify, SignJWT } from 'jose';
import { adminSessionSecret } from '../config';

/**
 * 后台会话 JWT（HS256，jose；机制同 apps/web/src/auth/jwt.ts，独立密钥与 cookie）。
 *
 * 载荷最小化：sub=adminId、kind='admin'。**scope/权限不进 token**——
 * 旧 grid 每次渲染实时判 `$user->cannot(...)`，1:1 语义 = 每请求走 adminService.
 * resolveScope（登录态变了/权限改了立刻生效，无 TTL 窗口内的权限滞留）。
 */
export interface AdminTokenPayload {
  /** admin_users.id（字符串承载，Principal.subject 同构） */
  sub: string;
  kind: 'admin';
}

export type TokenVerifyOutcome =
  | { ok: true; payload: AdminTokenPayload }
  | { ok: false; code: 'MALFORMED_TOKEN' | 'EXPIRED' };

export async function signAdminToken(adminId: number, ttlSeconds: number): Promise<string> {
  return new SignJWT({ kind: 'admin' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(adminId))
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(adminSessionSecret());
}

export async function verifyAdminToken(token: string): Promise<TokenVerifyOutcome> {
  try {
    const { payload } = await jwtVerify(token, adminSessionSecret());
    if (payload.kind !== 'admin') return { ok: false, code: 'MALFORMED_TOKEN' };
    return { ok: true, payload: { sub: payload.sub ?? '', kind: 'admin' } };
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, code: 'EXPIRED' };
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }
}
