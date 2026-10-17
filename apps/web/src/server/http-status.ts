/**
 * member 域业务错误码 → HTTP 状态码（REST 边界的统一口径）。
 *
 * 词表正本在 packages/contract（错误码随域方法铺开登记）；这里只做状态映射：
 * - 4xx = 调用方问题（入参/凭证/账号状态）；5xx 保留给未预期异常
 * - 认证类（账号不存在/密码错误/待审核/被禁/限制登录）统一 401——与旧系统
 *   GraphQL 层行为一致，且不泄露「账号是否存在」（登录失败与不存在同码）
 * - 限流 429（旧系统同为拒绝，无专门状态；REST 面显式化）
 */
const STATUS_BY_CODE: Record<string, number> = {
  // 登录面
  MEMBER_LOGIN_INVALID: 400,
  MEMBER_LOGIN_RATE_LIMITED: 429,
  MEMBER_LOGIN_FAILED: 401,
  MEMBER_ACCOUNT_PENDING_REVIEW: 401,
  MEMBER_ACCOUNT_REVIEW_FAILED: 401,
  MEMBER_ACCOUNT_FORBIDDEN: 401,
  MEMBER_LOGIN_RESTRICTED: 401,
  // 资料面
  MEMBER_PROFILE_INVALID: 400,
  MEMBER_PRINCIPAL_INVALID: 401,
  MEMBER_NOT_FOUND: 404,
  // 收藏面
  FAVORITE_INVALID: 400,
  /** 同 URL 重复收藏（旧系统 UserError；REST 面显式化为 409 Conflict） */
  FAVORITE_GOODS_URL_DUPLICATE: 409,
  FAVORITE_NOT_FOUND: 404,
  // 订单面（旧 GraphQL UserError 文案 → REST 状态；409/404 显式化见 docs/plans/08）
  ORDER_NOT_FOUND: 404,
  NO_PERMISSIONS: 403,
  ORDER_NOT_ALLOWED_CANCEL: 409,
  ORDER_INVALID_TYPE: 400,
};

export function httpStatusForMemberError(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}
