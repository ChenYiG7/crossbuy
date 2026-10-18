/**
 * 分布式锁 / 冷却的接口（基础设施层，不含任何业务语义）。
 *
 * 存在的理由：下单链路的「SKU 冷却 + 进程锁」与加购链路的「商品目录锁」在旧系统里都是
 * `Cache::*`（Laravel 单实例进程内实现）。R1 若照抄进程内 Map，**多实例部署时闸门只在
 * 各自进程内生效**——等于没有闸门（TODO(#16)）。这两个接口是换 Redis 实现的落点。
 *
 * ⚠ 语义约定（守卫能不能真拦住，全看这三条）：
 *   1. `acquire` 是**抢占**语义：被占用返回 `null`，不排队、不阻塞。
 *   2. `release` 必须**带 token 比对**：进程 A 超时后锁过期、进程 B 抢到，A 再来释放
 *      会把 B 的锁删掉 ⇒ 互斥被击穿。释放谁的锁只能由持锁者决定。
 *   3. `ttlMs` 是**兜底自动过期**，不是正常释放路径：持锁进程崩溃时靠它解锁，
 *      所以 ttl 必须大于业务临界区的最大耗时（下单事务上限 300s 就是这么来的）。
 */

/** 抢锁结果：成功拿到 token；被占用则是 null */
export type AcquireResult = string | null;

export interface WithLockOptions {
  /** 锁自动过期时间（毫秒） */
  ttlMs: number;
  /** 抢不到时最多等待多久（毫秒），超时放弃 */
  waitMs: number;
  /** 轮询间隔（毫秒），默认 50 */
  pollMs?: number;
}

export type WithLockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface DistributedLock {
  /** 抢占锁，成功返回 token，被占用返回 null */
  acquire(key: string, ttlMs: number): Promise<AcquireResult>;
  /** 释放自己持有的锁（token 不匹配则不动），返回是否真的释放了 */
  release(key: string, token: string): Promise<boolean>;
  /** 等待 + 持锁执行（旧 `Cache::lock()->block(N)` 语义）；抢不到返回 `{acquired:false}` */
  withLock<T>(key: string, opts: WithLockOptions, fn: () => Promise<T>): Promise<WithLockResult<T>>;
}

/**
 * 冷却窗口（旧 `Cache::has` / `Cache::put` 的 1:1 抽象）。
 * 与锁的区别：不互斥，只是「这段时间内这事刚做过，别重复做」。
 */
export interface CooldownStore {
  has(key: string): Promise<boolean>;
  put(key: string, ttlMs: number): Promise<void>;
}

/**
 * 幂等标记（处理「这事刚做过，别重做」——和冷却的区别：冷却是时间窗，幂等是「已完成」标记）。
 *
 * 用途：队列消费的幂等护栏。BullMQ 的 jobId 只能拦「同一 jobId 重复入队」，拦不住
 * 「不同 jobId 但代表同一件事」（如重试 / 上游重复投递 / 跨连接重放）。`claim` 用
 * `SET key 1 NX PX`——抢到标记 = 第一次处理；抢不到 = 已经处理过，直接跳过。
 *
 * ⚠ ttlMs 必须远大于「同一件事可能重复到达的最大时间窗」（订单邮件取 30 天），
 * 否则标记过期后重复事件会二次触发。过期不是正常释放路径，只是兜底防永久堆积。
 */
export interface IdempotencyStore {
  /** 抢占「已完成」标记；成功（第一次）返回 true，已被占用（重复）返回 false */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** 该 key 是否仍被占用（用于测试 / 排查） */
  has(key: string): Promise<boolean>;
  /** 主动清除（测试隔离 / 手动补救） */
  forget(key: string): Promise<void>;
}

/**
 * 通用 TTL 缓存（旧 Laravel `Cache::get/put/forget` 的最小子集，值 = 字符串）。
 *
 * 与 CooldownStore 的区别：冷却只存「做过没有」的标记，这里存**内容**（如 1688 分销
 * 详情的原始响应体）。`get` 未命中 / 已过期返回 `null`；`put` 的 ttlMs 到期自动失效。
 *
 * ⚠ 多实例部署要共享缓存（命中率）必须用 Redis 实现；内存实现只在单实例/本地开发用。
 */
export interface TtlCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlMs: number): Promise<void>;
  forget(key: string): Promise<void>;
}
