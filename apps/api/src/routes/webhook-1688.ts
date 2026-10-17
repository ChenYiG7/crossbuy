import { z } from 'zod';
import { webhook1688AckSchema, webhook1688MessageSchema } from '@crossbuy/contract';
import type { ZodApp } from '../types';
import { getWebhook1688Service } from '../composition';

/**
 * 1688 入站 webhook（旧 routes/api.php `webhooks/1688` 平移）。
 *
 * ⚠ 不受 HMAC/IP 守卫（独立 scope）：回调方是 1688 服务器，不可能持有我方签名；
 * 旧路由仅挂 log_operation。防护 = update1688PaidOrders 条件 UPDATE 的天然幂等
 * （S19 范本）+ 事件分支内的白名单校验。
 *
 * 响应形态 1:1 旧控制器（**非**统一 Envelope——第三方回调的成败信号是给重试机制的，
 * 改形态破坏上游重试语义）：200 = 已受理；503 = 瞬时失败（retryable:true，上游重试）。
 * 入参 1:1 旧 request()->get('message')：form 或 json 的 `message` 字段 = JSON 字符串。
 */
export async function webhook1688Routes(app: ZodApp): Promise<void> {
  app.post(
    '/api/webhook/v1/1688',
    {
      schema: {
        tags: ['webhook'],
        summary: '1688 订单事件回调（支付面；建单事件 S24 后置）',
        body: z
          .object({ message: z.string().optional() })
          .passthrough(),
        response: {
          200: webhook1688AckSchema,
          503: webhook1688AckSchema,
        },
      },
    },
    async (req, reply) => {
      // 1:1 旧 json_decode(request()->get('message'))：解析失败 → 200 + retryable:false
      let message: unknown = null;
      const raw = (req.body as { message?: string } | undefined)?.message;
      if (typeof raw === 'string') {
        try {
          message = JSON.parse(raw);
        } catch {
          message = null;
        }
      } else if (raw !== undefined) {
        message = raw; // json body 直接内嵌对象形态（兼容）
      }

      const parsed = webhook1688MessageSchema.safeParse(message);
      if (!parsed.success) {
        return reply.code(200).send({
          success: false,
          event_type: '*',
          retryable: false,
          reason: 'invalid webhook message',
        });
      }

      const outcome = await getWebhook1688Service().handle(parsed.data);
      return reply.code(outcome.retryable ? 503 : 200).send(outcome.ack);
    },
  );
}
