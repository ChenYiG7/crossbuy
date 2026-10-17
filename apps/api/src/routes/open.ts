import { z } from 'zod';
import type { ZodApp } from '../types';

/**
 * 受保护的开放面路由 —— **存在的主要目的是让守卫可被验证**
 * （「守卫有效性是破坏出来的」：没有受保护路由，就没法证明签名/IP 白名单真的拦得住）。
 *
 * M1 起这里换成真正的开放 API（建单/取消/支付，语义平移自 `routes/api.php` 的 67 条，
 * 见 docs/04 §4-6，路径与认证语义保持不变 ⇒ 外部调用方零感知）。
 */
export async function openRoutes(app: ZodApp): Promise<void> {
  // POST + body：用于验证「body 参与签名」—— 篡改 body 必须 401。
  // （GET 带 body 时 Fastify 不解析 body，签名里就没有 body，验证不了这一点。）
  app.post(
    '/api/open/v1/echo',
    {
      schema: {
        tags: ['open'],
        summary: '回显（需 HMAC 签名 + IP 白名单，body 参与签名）',
        body: z.object({ text: z.string().min(1).max(200) }),
        response: {
          200: z.object({
            code: z.number(),
            message: z.string(),
            data: z.object({ echo: z.string() }).nullable(),
            traceId: z.string(),
          }),
        },
      },
    },
    async (req) => ({
      code: 0,
      message: 'ok',
      data: { echo: req.body.text },
      traceId: req.traceId,
    }),
  );

  app.get(
    '/api/open/v1/ping',
    {
      schema: {
        tags: ['open'],
        summary: '连通性探测（需 HMAC 签名 + IP 白名单）',
        response: {
          200: z.object({
            code: z.number(),
            message: z.string(),
            data: z.object({ pong: z.literal(true) }).nullable(),
            traceId: z.string(),
          }),
        },
      },
    },
    async (req) => ({
      code: 0,
      message: 'ok',
      data: { pong: true as const },
      traceId: req.traceId,
    }),
  );
}
