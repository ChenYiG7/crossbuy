import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawServerDefault,
} from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * 带 zod type provider 的 Fastify 实例类型。
 *
 * 路由插件用它声明参数类型 ⇒ `req.body` 由 zod schema 自动推断、`req.traceId` 由
 * trace-id 插件的 declaration merging 提供 —— **不要靠 `as never` 绕过类型**
 * （绕过之后响应体字段写错、traceId 拼错都只能在运行时炸）。
 */
export type ZodApp = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  ZodTypeProvider
>;
