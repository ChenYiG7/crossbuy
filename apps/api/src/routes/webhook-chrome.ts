import { chromeResultSchema, chromeWebhookSchema } from '@crossbuy/contract';
import type { ApiConfig } from '../config';
import { getAdminService, getChromeService } from '../composition';
import { resolveAdminId } from '../auth-admin-session';
import { decodeOrderDetail, type ChromeWebhookInput } from '@crossbuy/domain-order';
import type { ZodApp } from '../types';
import { z } from 'zod';

/**
 * chrome 插件回传（旧 `routes/api.php` `webhooks/chrome` 平移；语义 1:1）。
 *
 * 认证：后台登录态（旧 `Admin::user()` 从 `x-laravel-session` 解出）→ 新系统 admin JWT
 * （Bearer 或 `cb_admin_session` cookie）。**不挂 HMAC/IP 守卫**：调用方是自家插件、
 * 身份就是后台账号本身，签名对它没有意义（旧路由同样只挂 log_operation）。
 *
 * 响应形态 1:1 旧控制器：恒 HTTP 200 + 业务信封 `{code:200}` / `{code:40000,msg}`
 * （插件按 code 分支，改 HTTP 语义会让它把失败当成功）。
 */
export async function webhookChromeRoutes(app: ZodApp, opts: { config: ApiConfig }): Promise<void> {
  app.post(
    '/api/webhook/v1/chrome',
    {
      schema: {
        tags: ['webhook'],
        summary: 'chrome 插件回传（校验/保存/发货，后台登录态鉴权）',
        body: chromeWebhookSchema,
        response: {
          200: chromeResultSchema,
          401: z.object({ message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const adminId = await resolveAdminId(req, opts.config.AUTH_SESSION_SECRET);
      if (adminId === null) return reply.code(401).send({ message: 'Unauthorized.' });

      const admin = await getAdminService().getIdentity(adminId);
      if (!admin) return reply.code(401).send({ message: 'Unauthorized.' });

      const input = toChromeInput(req.body);
      const result = await getChromeService(app.log).handle(input, admin);
      return reply.code(200).send(result);
    },
  );
}

/** 信封 → 域入参（旧 webhookForChrome 的 `$oids`/`$extra` 组装 1:1） */
function toChromeInput(body: z.infer<typeof chromeWebhookSchema>): ChromeWebhookInput {
  const oids = Array.isArray(body.oids)
    ? body.oids.map((v) => String(v)).join(',')
    : (body.oids ?? '');
  return {
    oids: String(oids),
    tradeId: body.trade_id === null || body.trade_id === undefined ? '' : String(body.trade_id),
    action: body.action,
    tradeType: body.trade_type ?? 1,
    orderDetail: decodeOrderDetail(body.order_detail),
    // 旧 `Arr::get($extra,'skip_price_check', false)`：0/1/'0'/'1'/'true' 都当布尔用
    skipPriceCheck:
      body.skip_price_check === true ||
      body.skip_price_check === 1 ||
      body.skip_price_check === '1' ||
      body.skip_price_check === 'true',
    // ACTION_CREATE_1688_ORDER(8) 建单入参（旧 create1688Order 从 $request->all() 取；
    // camelCase 是旧插件契约）。空判/遍历在 purchase 域端口按 PHP empty() 语义做。
    accountName: body.accountName,
    addressInfo: body.addressInfo,
    itemInfo: body.itemInfo,
    message: body.message,
  };
}
