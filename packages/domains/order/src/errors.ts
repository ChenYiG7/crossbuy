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
  // ---- 加购面（旧 AddCartMutation + lang('graphql-message.cart.*') / lang('api.*')）----
  /** 旧 `throw new UserError(__('goodsList is required'))`：语言键缺失 → 原样回显 */
  CART_GOODS_LIST_REQUIRED: 'goodsList is required',
  /** 旧 graphql-message.cart.max_count_reached（`:maxCount` 占位在服务层替换） */
  CART_MAX_COUNT_REACHED: '购物车数量已达上限（:maxCount 个）。',
  /** 旧 graphql-message.cart.goods_off_shelf */
  CART_GOODS_OFF_SHELF: '商品已下架或不存在，无法再次购买',
  /** 旧 graphql-message.cart.goods_url_mismatch */
  CART_GOODS_URL_MISMATCH: '商品 URL 不一致，无法批量加入购物车。',
  /** 旧 graphql-message.system.service_busy（分布式锁抢不到的兜底） */
  CART_SERVICE_BUSY: '服务繁忙，请稍后重试',
  /** 旧 api.below_min_order_quantity（`:name`/`:qty`/`:min` 占位在服务层替换） */
  CART_BELOW_MIN_ORDER_QUANTITY:
    '商品「:name」合计数量 :qty 未达到最低起订量 :min。同一商品的全部规格按总数计算',
} as const;

export type OrderErrorCode = keyof typeof ORDER_ERROR_MESSAGES;

export function orderError(code: OrderErrorCode): OrderError {
  return { code, message: ORDER_ERROR_MESSAGES[code] };
}
