/**
 * 登录限流端口（旧 LoginMutation：`RateLimiter::attempt('login-attempts-'.$uname, 5)`）。
 *
 * 语义 1:1 复现 Laravel `Illuminate\Cache\RateLimiter`（decay 默认 60s，旧代码未传）：
 * - 窗口从**首次**命中起算 60 秒（固定窗口，不是滑动窗口）；窗口过期后计数清零
 * - attempt 先查后计：窗口内计数已达上限 → false（拒绝）；否则计数 +1 → true
 * - **所有**尝试都计数（密码错误、成功登录、被后续闸门拒绝的都算）
 */
export interface LoginRateLimiter {
  attempt(key: string): boolean;
}

/**
 * 单实例内存实现（窗口状态在进程内）。
 * ⚠ 多实例部署时限流会按实例分裂——换 Redis 实现（随基建/worker 落地，TODO 登记）；
 * 旧系统走 Laravel Cache（生产若为 file 驱动同样按实例分裂，行为不算退步）。
 */
export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly hits = new Map<string, { count: number; windowEndsAt: number }>();

  constructor(
    private readonly options: {
      maxAttempts?: number;
      decaySeconds?: number;
      /** 测试注入时钟，避免真实等待 */
      now?: () => number;
    } = {},
  ) {}

  attempt(key: string): boolean {
    const maxAttempts = this.options.maxAttempts ?? 5;
    const decayMs = (this.options.decaySeconds ?? 60) * 1000;
    const now = this.options.now?.() ?? Date.now();

    const current = this.hits.get(key);
    if (!current || now >= current.windowEndsAt) {
      this.hits.set(key, { count: 1, windowEndsAt: now + decayMs });
      return true;
    }
    if (current.count >= maxAttempts) return false;
    current.count += 1;
    return true;
  }
}
