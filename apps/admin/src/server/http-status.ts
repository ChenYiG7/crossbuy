/** admin 域错误码 → HTTP 状态（admin 端路由用；与 web 端同语义） */
const STATUS_BY_CODE: Record<string, number> = {
  // 认证面
  ADMIN_INVALID_CREDENTIALS: 401,
  ADMIN_PRINCIPAL_INVALID: 401,
  ADMIN_NOT_FOUND: 404,
  ADMIN_MALFORMED_TOKEN: 401,
  ADMIN_EXPIRED: 401,
  // member 域（admin 列表复用）
  MEMBER_ADMIN_QUERY_INVALID: 400,
};

export function httpStatusForAdminError(code: string): number {
  return STATUS_BY_CODE[code] ?? 500;
}
