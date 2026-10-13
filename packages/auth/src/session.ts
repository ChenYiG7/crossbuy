import type { MemberId } from '@crossbuy/contract';

/** 前台会员会话（JWT 载荷）。dfFlag 代发用户与普通会员共用一套会话。 */
export interface MemberSession {
  memberId: MemberId;
  email: string;
  /** 代发标记 */
  isDf: boolean;
}

/** 后台运营会话（RBAC，替代旧 dcat-admin 权限） */
export interface AdminSession {
  adminId: number;
  /** 角色 key 列表 */
  roles: string[];
  /** 按钮级权限点 */
  perms: string[];
}
