import type { Result } from '@crossbuy/utils';
import type { Principal } from './principal';

/**
 * TokenVerifier —— 三端认证的统一校验接口（docs/04 §6）。
 *
 * 三个实现分处：
 * - 会员端：Auth.js（NextAuth v5）JWT 校验（apps/web、apps/mzk）
 * - 后台端：Session + Redis（RBAC + belongCompany 数据权限，apps/admin）
 * - 开放端：API key / 签名（apps/api，语义平移旧 verify_open_api）
 *
 * 域服务只依赖本接口，R3 抽认证中心时零改动。
 */

/** 鉴权失败原因（可预期分支，走 Result 不抛异常） */
export type AuthErrorCode = 'MISSING_TOKEN' | 'MALFORMED_TOKEN' | 'EXPIRED' | 'REVOKED' | 'UNTRUSTED_ISSUER' | 'INTERNAL';

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly message: string;
}

export interface TokenVerifier {
  /** 校验原始 token（Bearer 值 / sessionId / 签名串），成功返回 Principal */
  verify(token: string): Promise<Result<Principal, AuthError>>;
}
