import { z } from 'zod';

/**
 * 服务端环境变量 schema：启动即校验，缺配置直接失败，禁止运行时到处读 process.env 裸奔。
 * 每个 app/worker 启动时调 parseEnv()。
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(raw);
}
