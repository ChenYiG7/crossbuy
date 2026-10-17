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
  /** 旧 graphql-message.cart.not_found */
  CART_NOT_FOUND: '购物车记录不存在',
  /** 旧 handle() 的 `throw new UserError('type error!')`（类型混装且含代发） */
  ORDER_TYPE_MIXED: 'type error!',
  /** 旧 graphql-message.order.sku_creating（30s 冷却 / 进程锁占用） */
  ORDER_SKU_CREATING: '同一规格 30 秒内只能创建一次订单，请稍后再试！',
  /** 旧 graphql-message.order.insufficient_balance */
  ORDER_INSUFFICIENT_BALANCE: '您的余额不足，请先充值再下单！',
  /** 入参不合法（旧 GraphQL String! 层校验；REST 面显式化） */
  ORDER_PLACE_INPUT_INVALID: '入参不合法',
} as const;

export type OrderErrorCode = keyof typeof ORDER_ERROR_MESSAGES;

export function orderError(code: OrderErrorCode): OrderError {
  return { code, message: ORDER_ERROR_MESSAGES[code] };
}
