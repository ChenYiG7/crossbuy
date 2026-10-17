import { z } from 'zod';
import type { ZodApp } from '../types';

/**
 * 健康检查（docs/06 任务 0.4 验收项）。
 * 路径按 docs/04 §4-2 规范：开放面 `/api/open/v1/...`、webhook 面 `/api/webhook/v1/...`。
 * 两条都在守卫豁免名单里 —— 外部探活不该被签名拦住。
 */
const healthData = z.object({
  status: z.literal('ok'),
  ts: z.string(),
  service: z.string(),
});

export async function healthRoutes(app: ZodApp): Promise<void> {
  const handler = async (req: { traceId: string }) => ({
    code: 0,
    message: 'ok',
    data: {
      status: 'ok' as const,
      ts: new Date().toISOString(),
      service: 'api',
    },
    traceId: req.traceId,
  });

  app.get(
    '/api/open/v1/health',
    {
      schema: {
        tags: ['open'],
        summary: '开放 API 健康检查',
        response: {
          200: z.object({
            code: z.number(),
            message: z.string(),
            data: healthData.nullable(),
            traceId: z.string(),
          }),
        },
      },
    },
    handler,
  );

  app.get(
    '/api/webhook/v1/health',
    {
      schema: {
        tags: ['webhook'],
        summary: 'Webhook 健康检查',
        response: {
          200: z.object({
            code: z.number(),
            message: z.string(),
            data: healthData.nullable(),
            traceId: z.string(),
          }),
        },
      },
    },
    handler,
  );
}
