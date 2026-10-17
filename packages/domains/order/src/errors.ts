/**
 * order 域错误（docs/07：可预期业务失败走 Result，禁抛异常承载分支）。
 * 错误消息 = 旧系统 lang('graphql-message.*') 文案 1:1（禁顺手改写——灰度期双跑 diff 对齐）。
 */
export interface OrderError {
  readonly code: string;
  readonly message: string;
}

/** 旧 graphql-message.php 词表（取消链路用到的子集；正本见旧 lang/zh_CN/graphql-message.php） */
export const ORDER_ERROR_MESSAGES = {
  ORDER_NOT_FOUND: '订单不存在',
  NO_PERMISSIONS: '没有操作权限',
  ORDER_NOT_ALLOWED_CANCEL: '订单当前状态不允许取消',
  ORDER_INVALID_TYPE: '订单类型不合法',
} as const;

export type OrderErrorCode = keyof typeof ORDER_ERROR_MESSAGES;

export function orderError(code: OrderErrorCode): OrderError {
  return { code, message: ORDER_ERROR_MESSAGES[code] };
}
