import { z } from 'zod';

/**
 * apps/admin 环境变量（懒加载 + fail-fast；机制同 apps/web/src/config.ts——
 * Next route 模块在 build 期被求值，顶层 throw 会误伤无 env 构建，懒到首请求才校验）。
 */
const adminConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** 后台会话 JWT 签名密钥；**production 必填** */
  AUTH_SESSION_SECRET: z.string().min(16).optional(),
  /** 后台会话 TTL（秒）；旧 dcat session 2 小时空闲过期——先取同量级保守值 */
  AUTH_SESSION_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60),
});

export type AdminConfig = z.infer<typeof adminConfigSchema>;

const DEV_FALLBACK_SECRET = 'dev-only-insecure-admin-secret-do-not-use-in-prod';

let cached: AdminConfig | null = null;
let devWarned = false;

export function getAdminConfig(): AdminConfig {
  if (cached) return cached;
  const parsed = adminConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`apps/admin 环境变量校验失败：\n${detail}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.AUTH_SESSION_SECRET) {
    throw new Error(
      'AUTH_SESSION_SECRET 未设置：生产环境必须配置后台会话签名密钥（见 .env.example）',
    );
  }
  cached = parsed.data;
  return cached;
}

export function adminSessionSecret(): Uint8Array {
  const config = getAdminConfig();
  if (!config.AUTH_SESSION_SECRET) {
    if (!devWarned) {
      devWarned = true;
      console.warn('[admin] AUTH_SESSION_SECRET 未设置，使用固定开发密钥（仅限本地开发）');
    }
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }
  return new TextEncoder().encode(config.AUTH_SESSION_SECRET);
}
