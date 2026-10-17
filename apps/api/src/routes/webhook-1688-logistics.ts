import type { FastifyInstance } from 'fastify';
import { webhook1688LogisticsMessageSchema } from '@crossbuy/contract';
import { getWebhook1688LogisticsService } from '../composition';

/**
 * 1688 物流服务商入站 webhook（旧 routes: api/1688-logistics-provider 同位）。
 * 无守卫 scope（1688 不持我方签名）；防护 = 契约白名单 + 条件幂等写。
 * 响应 1:1 旧控制器：成功固定 SUCCESS 信封；参数不合法 500（旧 json_decode 失败 fatal 同语义，
 * 1688 侧重试）。
 */
export async function webhook1688LogisticsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhook/1688-logistics-provider', async (request, reply) => {
    const service = getWebhook1688LogisticsService();
    // 旧 request()->get('message') form 兼容：urlencoded body.message 或 JSON body 直传
    const raw = (request.body as { message?: unknown } | null)?.message ?? request.body;
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return reply.status(500).send({ message: 'invalid message json' });
      }
    }

    const checked = webhook1688LogisticsMessageSchema.safeParse(parsed);
    if (!checked.success) {
      // 旧代码缺字段 fatal → 500 重试语义
      return reply.status(500).send({ message: 'invalid message', detail: checked.error.message });
    }

    await service.consume(checked.data);
    return reply.send({ code: 'SUCCESS', message: '', success: true });
  });
}
