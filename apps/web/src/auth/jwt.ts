import { errors, jwtVerify, SignJWT } from 'jose';
import { sessionSecret } from '../config';

/**
 * 会员会话 JWT（HS256，jose）。
 *
 * 端上实现之一（docs/04 §6：三端各自实现认证，域服务只认 Principal）：
 * #9（Auth.js v5 + JWT 全量）落地时替换签发/校验细节即可，路由与域代码不动。
 * 载荷保持最小：sub=uid、kind、isDf（dfFlag 分流在会话层用，不进 Principal）。
 */
export interface MemberTokenPayload {
  /** 会员 uid（字符串承载，Principal.subject 同构） */
  sub: string;
  kind: 'member';
  isDf: boolean;
}

export type TokenVerifyOutcome =
  | { ok: true; payload: MemberTokenPayload }
  | { ok: false; code: 'MALFORMED_TOKEN' | 'EXPIRED' };

export async function signMemberToken(
  uid: number,
  isDf: boolean,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ kind: 'member', isDf })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(uid))
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(sessionSecret());
}

/** 校验会员会话 JWT；过期/篡改/非会员载荷都是可预期失败，返回码不抛异常 */
export async function verifyMemberToken(token: string): Promise<TokenVerifyOutcome> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    if (payload.kind !== 'member') return { ok: false, code: 'MALFORMED_TOKEN' };
    return {
      ok: true,
      payload: { sub: payload.sub ?? '', kind: 'member', isDf: payload.isDf === true },
    };
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, code: 'EXPIRED' };
    return { ok: false, code: 'MALFORMED_TOKEN' };
  }
}
