import { z } from 'zod';

/**
 * admin 域契约 —— 后台管理员认证 + RBAC 数据范围（2026-10-17，M1 §四-4）。
 *
 * 与 member 域的关键差异：
 * - 密码是 **bcrypt**（$2y$…，dcat-admin/Laravel Hash），不是 member 的 MD5；
 * - 权限模型 = dcat RBAC：admin_user → roles → permissions（slug 判定），
 *   无 user 直挂权限（库无 admin_permission_users 表，只有 admin_role_permissions）；
 * - 数据范围（scope）由权限 + 管理员自己的 business_manager 分组推导，
 *   每次请求实时判定（1:1 旧 grid `$user->cannot(...)` 行为），不进 token。
 */

/** 后台登录入参（旧 dcat AuthController::handle：username + password） */
export const adminLoginSchema = z.object({
  username: z.string().min(1).max(120),
  password: z.string().min(1).max(128),
});
export type AdminLoginInput = z.infer<typeof adminLoginSchema>;

/**
 * 用户列表数据范围（旧 UserController::grid 的三条分支 1:1）：
 * - all：有 `ability-view-all-users` 权限 → 不加过滤；
 * - flags：无该权限但 business_manager 分组非空 → memberid LIKE '{flag}%' OR memberid 空串/NULL
 *   （旧代码的 orWherememberid 空/NULL 是**有意行为**——未分组客户所有人可见）；
 * - none：无权限且无分组 → 1=0 空集（旧代码同款，页面提示「绑定业务员角色」）。
 */
export const adminScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('flags'), flags: z.array(z.string().min(1).max(2)).min(1) }),
  z.object({ kind: z.literal('none') }),
]);
export type AdminScope = z.infer<typeof adminScopeSchema>;

/** 业务员 flag → 展示名映射（旧 AdminUser::getBusinessManagers：角色 slug ∈ 四个业务员角色） */
export const businessManagerEntrySchema = z.object({
  flag: z.string().min(1).max(2),
  label: z.string().min(1),
});
export type BusinessManagerEntry = z.infer<typeof businessManagerEntrySchema>;

/** 登录成功返回（scope 实时值快照，仅供页面提示；列表过滤以服务端实时判定为准） */
export const adminProfileSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  name: z.string(),
  scope: adminScopeSchema,
  /** 全局业务员名册（grid「客户代号」列展示用，与本人 scope 无关） */
  businessManagers: z.array(businessManagerEntrySchema),
});
export type AdminProfile = z.infer<typeof adminProfileSchema>;

/**
 * 会员列表查询入参（admin 只读视图；旧 dcat grid 默认 = 全量 uid 倒序分页，
 * 关键字过滤是 REST 面新增便利项——语义为 LIKE，不改旧行为）。
 */
export const adminUserListQuerySchema = z.object({
  q: z.string().max(64).optional(),
  utype: z.number().int().optional(),
  state: z.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;

/** 列表行（只读：旧 grid 用户信息列的字段子集；money 字符串承载禁浮点） */
export const adminUserListItemSchema = z.object({
  uid: z.number().int(),
  uname: z.string(),
  tname: z.string().nullable(),
  email: z.string().nullable(),
  tel: z.string().nullable(),
  memberid: z.string().nullable(),
  utype: z.number().int(),
  state: z.number().int(),
  money: z.string(),
  regtype: z.number().int().nullable(),
});
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

export const adminUserListResultSchema = z.object({
  items: z.array(adminUserListItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});
export type AdminUserListResult = z.infer<typeof adminUserListResultSchema>;
