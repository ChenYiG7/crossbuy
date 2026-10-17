import {
  AdminRepository,
  AdminServiceImpl,
  BcryptPasswordVerifier,
  type AdminService,
} from '@crossbuy/domain-admin';
import {
  InMemoryLoginRateLimiter,
  Md5PasswordVerifier,
  MemberRepository,
  MemberServiceImpl,
  type MemberService,
} from '@crossbuy/domain-member';
import { AdminTokenVerifier } from '../auth/admin-verifier';

/**
 * 组合根（apps/admin 唯一装配处）。
 *
 * admin app 同时装配 **admin 域（认证/RBAC）+ member 域（用户列表数据）**——
 * 薄壳跨域装配是合法的（域间仍互不 import；dg_users 查询走 member service 接口，
 * admin_* 表走 admin repository，表属主纪律不破）。
 *
 * 进程内单例（Next dev 热替换重建，无状态泄漏风险）。
 */
let adminService: AdminService | null = null;
let memberService: MemberService | null = null;
let adminVerifier: AdminTokenVerifier | null = null;

export function getAdminService(): AdminService {
  adminService ??= new AdminServiceImpl(new AdminRepository(), new BcryptPasswordVerifier());
  return adminService;
}

export function getMemberService(): MemberService {
  memberService ??= new MemberServiceImpl(
    new MemberRepository(),
    new Md5PasswordVerifier(),
    new InMemoryLoginRateLimiter(),
    // admin 列表不涉及头像读侧补前缀（列表无 face 字段）；资料编辑写路径属会员端，不在此装配
    { ossFullHost: '', ossCdnUrl: '' },
  );
  return memberService;
}

export function getAdminVerifier(): AdminTokenVerifier {
  adminVerifier ??= new AdminTokenVerifier();
  return adminVerifier;
}
