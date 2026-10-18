import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { traceIdPlugin } from './plugins/trace-id';
import { guardPlugin } from './plugins/guard';
import { healthRoutes } from './routes/health';
import { openRoutes } from './routes/open';
import { webhook1688Routes } from './routes/webhook-1688';
import { webhook1688LogisticsRoutes } from './routes/webhook-1688-logistics';
import { webhookChromeRoutes } from './routes/webhook-chrome';
import type { ApiConfig } from './config';

/** 守卫豁免路径：健康检查与文档（外部探活/看文档不该被签名拦住） */
// ⚠ 文档 JSON 的实际路径是 `/docs/json`：注册 @fastify/swagger-ui 时指定的 routePrefix
// 会一并决定它（不是 @fastify/swagger 默认的 /documentation/json）—— 由 printRoutes() 实测确认。
export const GUARD_EXEMPT_PATHS = [
  '/api/open/v1/health',
  '/api/webhook/v1/health',
  '/docs/json',
];

/**
 * 构建 app（**不监听**）—— 测试可直接注入请求，不需要起端口。
 * docs/04 §4-4：契约（zod）→ OpenAPI 3 由 zod schema 自动生成，不手写文档。
 */
export async function buildApp(config: ApiConfig) {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(traceIdPlugin);

  await app.register(import('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'crossbuy API',
        description: '机器面：开放 API + webhook（R1 复现期，契约先行）',
        version: '1.0.0',
      },
      tags: [
        { name: 'open', description: '开放 API（HMAC 签名 + IP 白名单）' },
        { name: 'webhook', description: '第三方回调' },
        { name: 'chrome', description: 'chrome 插件回传（后台登录态）' },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(import('@fastify/swagger-ui'), { routePrefix: '/docs' });

  // ① 健康检查先注册：它在豁免名单里，永远可达
  await app.register(healthRoutes);

  // ② 受保护作用域：guard 只对注册在本 scope 内的路由生效（Fastify 封装）
  await app.register(async (scope) => {
    await scope.register(guardPlugin, {
      config,
      exempt: GUARD_EXEMPT_PATHS,
    });
    await scope.register(openRoutes);
  });

  // ③ webhook 作用域：**不挂 guard**（1688 回调方不可能持我方签名；旧路由仅 log_operation）。
  //    防护 = 事件分支白名单 + update1688PaidOrders 条件 UPDATE 天然幂等（S19 范本）。
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        const params = new URLSearchParams(String(body));
        const out: Record<string, string> = {};
        for (const [k, v] of params) out[k] = v;
        done(null, out);
      },
    );
    await scope.register(webhook1688Routes);
    await scope.register(webhook1688LogisticsRoutes);
    // chrome 插件回传：自带后台会话校验（不走 HMAC/IP 守卫，见路由文件注释）
    await scope.register(webhookChromeRoutes, { config });
  });

  return app;
}
