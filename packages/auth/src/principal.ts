/**
 * Principal —— 域服务唯一认的「谁」抽象（docs/04 §6 认证中心预留）。
 *
 * 纪律：域服务出入参只出现 Principal，禁 Auth.js / Session / token 细节；
 * 三个端（会员 JWT / 后台 Session / open 签名）各自实现 TokenVerifier，
 * R3 把实现抽到认证中心时域代码零改动。
 */

/** 端类型：三套认证语义（docs/04 §6 表） */
export type PrincipalKind = 'member' | 'admin' | 'openapi';

/** 后台数据权限行级隔离键（对应若依部门数据权限，映射 admin 查询守卫） */
export type CompanyId = string;

/**
 * 已鉴权主体。权限位 `permissions` 为按钮/接口级 key 列表（后台 RBAC）；
 * 会员端通常为空（会员只有自己的数据，按 subject 隔离）。
 */
export interface Principal {
  /** 主体 id：会员 uid / 员工 adminId / open api clientId（统一 string 承载） */
  readonly subject: string;
  /** 端类型 */
  readonly kind: PrincipalKind;
  /** 数据权限归属公司（后台用；会员/openapi 可空） */
  readonly belongCompany?: CompanyId;
  /** 权限位列表（后台 RBAC；会员/openapi 可空） */
  readonly permissions?: readonly string[];
}

/** 会员端 Principal 收口构造（web/mzk 的 Auth.js JWT 校验后调用；dfFlag 分流在会话层，不进 Principal） */
export function memberPrincipal(memberId: number): Principal {
  return { subject: String(memberId), kind: 'member' };
}

/** 后台端 Principal 收口构造（Session + Redis RBAC 校验后调用） */
export function adminPrincipal(
  adminId: number,
  opts?: { belongCompany?: CompanyId; permissions?: readonly string[] },
): Principal {
  return {
    subject: String(adminId),
    kind: 'admin',
    ...(opts?.belongCompany ? { belongCompany: opts.belongCompany } : {}),
    ...(opts?.permissions ? { permissions: opts.permissions } : {}),
  };
}

/** 开放 API Principal 收口构造（apps/api 签名/key 校验后调用） */
export function openApiPrincipal(
  clientId: string,
  opts?: { permissions?: readonly string[] },
): Principal {
  return {
    subject: clientId,
    kind: 'openapi',
    ...(opts?.permissions ? { permissions: opts.permissions } : {}),
  };
}
