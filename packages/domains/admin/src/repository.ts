import { legacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';
import type { BusinessManagerEntry } from '@crossbuy/contract';

/**
 * 后台管理员/RBAC/操作日志 域 repository 防腐层（docs/04 §5 / docs/07）。
 *
 * 本文件是 admin 域唯一允许 import @crossbuy/db 的位置——ESLint 边界规则强制，
 * 全仓其他位置 import 即 lint error（守卫有效性由 scripts/boundary-probe.mjs 破坏验证）。
 *
 * 纪律：
 * - 旧表原样读写，禁顺手清理列名；复现怪癖必须 1:1 并登记 docs/plans/08
 * - 时间戳 Asia/Shanghai 语义；金额读入即转 Decimal（utils/money 单入口）
 * - 别域数据禁直连表：dg_users 的列表查询在 member 域（listForAdmin），本文件只碰 admin_* 表族
 * - 写路径唯一入口 + 状态机 CAS（UPDATE ... WHERE status=from）随域铺开时落
 * - 属主旧表清单见 docs/plans/07-表属主映射.md
 */

/** 旧 `AdminUser::$roleBusinessManagers` 字面量 1:1——四个业务员角色 slug */
export const ROLE_BUSINESS_MANAGERS = [
  'df_business_manager',
  'dg_business_manager',
  'pt_business_manager',
  'oem_business_manager',
] as const;

/** 旧 `AdminUser::ABILITY_VIEW_ALL_USERS` 字面量 1:1 */
export const ABILITY_VIEW_ALL_USERS = 'ability-view-all-users';

export interface AdminAuthRecord {
  id: number;
  username: string;
  password: string;
  name: string;
  /** 旧模型 casts 'array' 的 JSON 串原样存储（`["G","I"]` / `[]` / '' / NULL） */
  businessManagerRaw: string | null;
  /** 软删标记（deleted_at 非空）——service 判「软删即拒登」用 */
  deleted: boolean;
}

export class AdminRepository {
  constructor(protected readonly db: LegacyPrismaClient = legacyPrisma) {}

  /**
   * 按用户名取认证记录。软删（deleted_at）**不在 SQL 里悄悄过滤**——
   * 带出 deleted 标记让「软删即拒登」在 service 显式判定（旧 dcat 用
   * SoftDeletingScope 隐式排除，行为等价、语义可见）。
   */
  async findAuthByUsername(username: string): Promise<AdminAuthRecord | null> {
    const row = await this.db.admin_users.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        password: true,
        name: true,
        business_manager: true,
        deleted_at: true,
      },
    });
    if (!row) return null;
    return {
      id: Number(row.id),
      username: row.username,
      password: row.password,
      name: row.name,
      businessManagerRaw: row.business_manager,
      deleted: row.deleted_at !== null,
    };
  }

  /** 按 id 取记录（resolveScope 用；同带 deleted 标记） */
  async findAuthById(id: number): Promise<AdminAuthRecord | null> {
    const row = await this.db.admin_users.findUnique({
      where: { id: BigInt(id) },
      select: {
        id: true,
        username: true,
        password: true,
        name: true,
        business_manager: true,
        deleted_at: true,
      },
    });
    if (!row) return null;
    return {
      id: Number(row.id),
      username: row.username,
      password: row.password,
      name: row.name,
      businessManagerRaw: row.business_manager,
      deleted: row.deleted_at !== null,
    };
  }

  /**
   * 是否持有 `ability-view-all-users` 权限（dcat `can()` 语义：任一角色授予权限即通过）。
   * 路径：admin_role_users → admin_role_permissions → admin_permissions.slug。
   * ⚠ 旧库无外键 → introspect 不生成关系字段，join 表只能两步查询（in 过滤），
   * 禁写 `permission: {...}` 关系过滤（P2002 校验错）。
   * 库无 user 直挂权限表（admin_permission_users 不存在），只有角色路径。
   */
  async canViewAllUsers(adminId: number): Promise<boolean> {
    const adminIdBig = BigInt(adminId);
    const roleRows = await this.db.admin_role_users.findMany({
      where: { user_id: adminIdBig },
      select: { role_id: true },
    });
    if (roleRows.length === 0) return false;

    const perm = await this.db.admin_permissions.findUnique({
      where: { slug: ABILITY_VIEW_ALL_USERS },
      select: { id: true },
    });
    if (!perm) return false;

    const granted = await this.db.admin_role_permissions.count({
      where: { permission_id: perm.id, role_id: { in: roleRows.map((r) => r.role_id) } },
    });
    return granted > 0;
  }

  /**
   * 全局业务员名册（旧 `AdminUser::getBusinessManagers()` 1:1）：
   * 角色 slug ∈ 四个业务员角色、`slug` 列非空的管理员 → flag(slug) → `name（flag）`。
   * 注意：这是**名册**（UI 展示用），与当前管理员自己的分组范围（business_manager 列）无关。
   * 同 flag 后取者覆盖前者（旧代码 map 语义），输出按 flag 稳定排序。
   * 同上：join 两步查询（role → user_id 集合 → admin_users in 过滤）。
   */
  async listBusinessManagers(): Promise<BusinessManagerEntry[]> {
    const roles = await this.db.admin_roles.findMany({
      where: { slug: { in: [...ROLE_BUSINESS_MANAGERS] } },
      select: { id: true },
    });
    if (roles.length === 0) return [];

    const links = await this.db.admin_role_users.findMany({
      where: { role_id: { in: roles.map((r) => r.id) } },
      select: { user_id: true },
    });
    if (links.length === 0) return [];

    const users = await this.db.admin_users.findMany({
      where: {
        id: { in: links.map((l) => l.user_id) },
        deleted_at: null,
        slug: { not: null },
      },
      select: { name: true, slug: true },
      orderBy: { id: 'asc' },
    });
    const byFlag = new Map<string, string>();
    for (const u of users) {
      if (u.slug) byFlag.set(u.slug, `${u.name}（${u.slug}）`);
    }
    return [...byFlag.entries()]
      .map(([flag, label]) => ({ flag, label }))
      .sort((a, b) => a.flag.localeCompare(b.flag));
  }
}
