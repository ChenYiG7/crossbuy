/**
 * 后台管理员/RBAC/操作日志 域错误（docs/07：可预期业务失败走 Result，禁抛异常承载分支）。
 * 错误码词表随域方法铺开时登记到 packages/contract/domains/admin.ts，
 * 与统一响应体 / 开放 API 业务码共用一套词汇（docs/04 §4-3）。
 */
export interface AdminError {
  readonly code: string;
  readonly message: string;
}
