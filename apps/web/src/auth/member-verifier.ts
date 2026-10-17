import type { AuthError, Principal, TokenVerifier } from '@crossbuy/auth';
import { memberPrincipal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import { verifyMemberToken } from './jwt';

/**
 * 会员端 TokenVerifier 实现（apps/web；docs/04 §6）。
 *
 * 域服务（MemberServiceImpl 等）只认本接口产出的 Principal——
 * R3 抽认证中心时换实现，域代码零改动。
 */
export class MemberTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<Result<Principal, AuthError>> {
    const outcome = await verifyMemberToken(token);
    if (!outcome.ok) {
      return err({
        code: outcome.code,
        message: outcome.code === 'EXPIRED' ? '会话已过期，请重新登录' : '会话无效',
      });
    }
    const uid = Number(outcome.payload.sub);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'MALFORMED_TOKEN', message: '会话主体非法' });
    }
    return ok(memberPrincipal(uid));
  }
}
