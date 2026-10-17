/**
 * 统一响应体（docs/04 §4-3）：`{ code, message, data, traceId }`。
 *
 * TODO(M1)：正本应收口到 `packages/contract`（契约 = 单一事实源，前后端 + 开放 API 共用），
 * 这里先由 apps/api 落地，待与后台/客户面联调时上移，避免多处分叉。
 */
export interface Envelope<T> {
  /** 0 = 成功；非 0 = 业务错误码（词表随各域铺开登记到 contract） */
  code: number;
  message: string;
  data: T | null;
  traceId: string;
}

export function envelopeOk<T>(data: T, traceId: string): Envelope<T> {
  return { code: 0, message: 'ok', data, traceId };
}

export function envelopeFail(
  code: number,
  message: string,
  traceId: string,
): Envelope<null> {
  return { code, message, data: null, traceId };
}
