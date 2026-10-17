import type { NextRequest } from 'next/server';
import type { Principal } from '@crossbuy/auth';
import type { Result } from '@crossbuy/utils';
import { ADMIN_SESSION_COOKIE_NAME } from '@/auth/cookies';
import { getAdminVerifier } from './container';

/**
 * 后台认证公共步：cookie → Principal（三路由/页面共用）。
 * RSC 页面用 cookies() 取值后同样走 verifyAdminPrincipal。
 */
export async function verifyAdminPrincipal(
  token: string | undefined | null,
): Promise<Result<Principal, { code: string; message: string }>> {
  if (!token) {
    return { ok: false, error: { code: 'ADMIN_MALFORMED_TOKEN', message: '未登录' } };
  }
  return getAdminVerifier().verify(token);
}

/** 从 cookie 取原始 token（后台只有 cookie 一路，无 Bearer——运营后台不做开放 API） */
export function adminTokenFromRequest(request: NextRequest): string | undefined {
  return request.cookies.get(ADMIN_SESSION_COOKIE_NAME)?.value;
}
