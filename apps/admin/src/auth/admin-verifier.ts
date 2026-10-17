import type { AuthError, Principal, TokenVerifier } from '@crossbuy/auth';
import { adminPrincipal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import { verifyAdminToken } from './jwt';

/**
 * 后台端 TokenVerifier 实现（apps/admin；docs/04 §6）。
 *
 * 与会员端的关键差异：**权限/数据范围不进 Principal 缓存**——verify 只还原
 * 「哪个管理员」，scope 每请求经 adminService.resolveScope 实时判定（1:1 旧 grid）。
 */
export class AdminTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<Result<Principal, AuthError>> {
    const outcome = await verifyAdminToken(token);
    if (!outcome.ok) {
      return err({
        code: outcome.code,
        message: outcome.code === 'EXPIRED' ? '会话已过期，请重新登录' : '会话无效',
      });
    }
    const adminId = Number(outcome.payload.sub);
    if (!Number.isInteger(adminId) || adminId <= 0) {
      return err({ code: 'MALFORMED_TOKEN', message: '会话主体非法' });
    }
    return ok(adminPrincipal(adminId));
  }
}
