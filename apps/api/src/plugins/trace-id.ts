import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** 全链路 ID：入参 X-Trace-Id 优先，否则生成 —— 统一响应体與日志都带它 */
    traceId: string;
  }
}

const HEADER = 'x-trace-id';

/**
 * traceId 插件（docs/04 §4-3：统一响应体必带 traceId）。
 * 入参头优先 ⇒ 上游（nginx / 客户面 / webhook 提供方）的链路能串起来。
 */
// ⚠ 必须用 fp 包装：在 register 的插件里调 decorateRequest，默认只作用于该插件的
// 封装子作用域，外面路由的 req 拿不到 traceId（首跑踩到：响应体 traceId undefined → 500）。
export const traceIdPlugin = fp(async (app: FastifyInstance): Promise<void> => {
  app.decorateRequest('traceId', '');
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers[HEADER];
    req.traceId = (typeof incoming === 'string' && incoming.trim()) || randomUUID();
    reply.header(HEADER, req.traceId);
  });
});
