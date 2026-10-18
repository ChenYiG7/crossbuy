import { z } from 'zod';

/**
 * apps/web 环境变量（懒加载 + fail-fast）。
 *
 * ⚠ 与 apps/api 的**模块顶层**加载的区别：Next 的 route 模块在 `next build` 时就会被
 * 求值，顶层 throw 会让没配 env 的构建直接失败——那是误伤。故懒到首次请求才校验；
 * 生产缺密钥照样 fail-fast（请求 500 + 明确错误），不给「悄悄放行」的机会。
 * ⚠ 密钥只走环境变量，不落代码/文档（记忆坑⑦：命令行内联密码会被脱敏成假值）。
 */
const webConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /** 会话 JWT 签名密钥；**production 必填**（缺失 = 无法签发/校验会话） */
  AUTH_SESSION_SECRET: z.string().min(16).optional(),
  /** 普通会话 TTL（秒） */
  AUTH_SESSION_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),
  /** 「记住我」会话 TTL（秒） */
  AUTH_SESSION_REMEMBER_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
  /**
   * 头像存储怪癖三件套（旧 EditUserInfoMutation / UserInfoType::resolveAvatarField，
   * 1:1 复现，见 domains/member/src/avatar.ts + docs/plans/08 S10）：
   * - OSS_BUCKET + OSS_INTERNAL_ENDPOINT 推导 ossFullHost（写侧剥离前缀）
   * - OSS_CDN_URL（读侧给相对 key 补前缀）
   * 全部可选：不配 = 不剥离/不补（开发期看库原值），**禁默认值冒充生产配置**。
   */
  OSS_BUCKET: z.string().optional(),
  OSS_INTERNAL_ENDPOINT: z.string().url().optional(),
  OSS_CDN_URL: z.string().url().optional(),
});

export type WebConfig = z.infer<typeof webConfigSchema>;

/** 开发期固定密钥（仅 NODE_ENV != production 允许走到） */
const DEV_FALLBACK_SECRET = 'dev-only-insecure-session-secret-do-not-use-in-prod';

let cached: WebConfig | null = null;
let devWarned = false;

export function getWebConfig(): WebConfig {
  if (cached) return cached;
  const parsed = webConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`apps/web 环境变量校验失败：\n${detail}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.AUTH_SESSION_SECRET) {
    throw new Error('AUTH_SESSION_SECRET 未设置：生产环境必须配置会话签名密钥（见 .env.example）');
  }
  cached = parsed.data;
  return cached;
}

/** 会话签名密钥（HS256）；开发期缺省时用固定值并 warn 一次 */
export function sessionSecret(): Uint8Array {
  const config = getWebConfig();
  if (!config.AUTH_SESSION_SECRET) {
    if (!devWarned) {
      devWarned = true;
      console.warn(
        '[auth] AUTH_SESSION_SECRET 未设置，使用开发期固定密钥——仅限本地开发，禁止上生产',
      );
    }
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }
  return new TextEncoder().encode(config.AUTH_SESSION_SECRET);
}
