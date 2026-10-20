/**
 * wms-gateway 域错误（docs/07：可预期业务失败走 Result，禁抛异常承载分支）。
 * 错误码词表登记到 packages/contract/domains/wms-gateway.ts（本域无对客错误文案，
 * 黑舟事件侧失败由重试/对账兜，不走 i18n 词典）。
 */
export interface WmsGatewayError {
  readonly code: string;
  readonly message: string;
}

export const WMS_GATEWAY_ERROR_MESSAGES = {
  /** 黑舟事件未命中状态映射表（fail-fast 显式登记，禁静默忽略——haiou 11 号 §0.2） */
  WMS_STATE_UNMAPPED: '黑舟事件未登记状态映射',
  /** 状态驱动型事实缺 oid / 归一化事实字段不足 */
  WMS_EVENT_INVALID: '黑舟事件归一化失败',
  /** order 域端口拒绝（cas 守卫/单据缺失等；message 携带 order 侧 code，供对账归因） */
  WMS_ORDER_STATE_REJECTED: '黑舟事件驱动的订单状态变更被拒绝',
  /** 黑舟指令下发失败（网络/协议/黑舟侧拒绝） */
  WMS_COMMAND_FAILED: '黑舟指令下发失败',
} as const;

export type WmsGatewayErrorCode = keyof typeof WMS_GATEWAY_ERROR_MESSAGES;

export function wmsGatewayError(code: WmsGatewayErrorCode, message?: string): WmsGatewayError {
  return { code, message: message ?? WMS_GATEWAY_ERROR_MESSAGES[code] };
}
