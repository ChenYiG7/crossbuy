import { z } from 'zod';

/**
 * 契约核心类型与 schema。
 * 契约包唯一运行时依赖是 zod——classpath 里没有 ORM、没有框架，
 * 「不污染契约」靠物理隔离，不靠自觉（system-kit c2 的 TS 版）。
 */

/** 金额：字符串承载（服务端重算，禁浮点）。语义与 @crossbuy/utils 的 Money 一致。 */
export type Money = string;

/** 分页入参 schema：调用方漏传也安全（<1 归 1、缺省 20、上限 100） */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;

/** 分页出参：list 永不为 null（约定） */
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 统一错误体（跨端一致） */
export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * 统一响应体（docs/04 §4-3）：`{ code, message, data, traceId }`。
 * 2026-10-17 由 apps/api 上移（原 TODO(M1)）：客户面 web 路由与机器面 api 共用，
 * 避免多处分叉。code 0 = 成功；非 0 = 业务错误码（词表随各域铺开登记到本包）。
 */
export interface Envelope<T> {
  code: number;
  message: string;
  data: T | null;
  traceId: string;
}

export function envelopeOk<T>(data: T, traceId: string): Envelope<T> {
  return { code: 0, message: 'ok', data, traceId };
}

export function envelopeFail(code: number, message: string, traceId: string): Envelope<null> {
  return { code, message, data: null, traceId };
}

/** 开放 API 业务码（旧系统 ApiResponse 约定，各域共用；成功为 200） */
export const OpenApiCode = {
  OK: 200,
  /** 无/无效 Bearer、token 未绑定 User */
  UNAUTHORIZED: 40100,
  /** 参数校验 / 业务校验（含 captcha_error 等 message 级细分） */
  VALIDATION: 40000,
  /** 余额不足 */
  INSUFFICIENT_BALANCE: 40010,
} as const;

/** 会员 id（品牌类型，防与订单/运单 id 混用） */
export type MemberId = number & { readonly __brand: 'MemberId' };
