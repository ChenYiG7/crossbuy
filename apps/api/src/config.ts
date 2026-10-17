import { z } from 'zod';

/**
 * apps/api 环境变量（启动即校验，缺/错直接 fail-fast——不给「跑起来再说」的机会）。
 *
 * ⚠ 密钥只走环境变量，不落代码/文档（记忆坑⑦：命令里内联的密码会被环境脱敏成假值）。
 */
export const apiConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /** 开放 API 面的签名密钥；**production 必填**（缺失 = 鉴权不可用 → 503，不是放行） */
  API_OPEN_HMAC_SECRET: z.string().min(1).optional(),
  /** 签名时间戳容忍窗口（秒），防重放 */
  API_OPEN_TS_TOLERANCE_SEC: z.coerce.number().int().positive().default(300),
  /** 开放 API 面 IP 白名单（逗号分隔，支持精确 IP 与 CIDR）；空 = 不限制（仅 dev） */
  API_OPEN_IP_ALLOWLIST: z.string().default(''),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = apiConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`apps/api 环境变量校验失败：\n${detail}`);
  }
  return parsed.data;
}

/** 逗号分隔 → 去空白去空串 */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
