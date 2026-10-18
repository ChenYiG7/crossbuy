/**
 * 旧库 INT unix 时间戳的统一出口（MEMORY：生产库 MySQL 会话时区 +08:00，
 * `FROM_UNIXTIME()` 输出北京时间；本机 PHP CLI 默认 UTC 会整体偏早 8 小时——
 * 所有 unix→可读时间的转换必须走本文件，禁散落 `new Date(ts * 1000)`）。
 */

/** Asia/Shanghai 自 1991 年起无夏令时，固定 +08:00（IANA tz 数据库） */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * unix epoch 秒 → ISO 8601 字符串（带 +08:00 偏移，如 `2024-08-16T12:00:00+08:00`）。
 * 契约层时间字段的统一格式（REST 出参；禁回 int 时间戳，也禁 UTC 的 Z 尾——
 * 对客展示以北京时间为准）。
 */
export function unixToIso(seconds: number): string {
  if (!Number.isFinite(seconds)) throw new Error(`unixToIso: 非有限时间戳 ${seconds}`);
  const shifted = new Date(seconds * 1000 + SHANGHAI_OFFSET_MS);
  return shifted.toISOString().slice(0, 19) + '+08:00';
}

/**
 * JS Date（UTC 瞬时）→ 写入 MySQL **DATETIME 列**用的 Date。
 *
 * 实测（2026-10-18，本机 MySQL 9.7 + Prisma 6）：Prisma 把 Date 按 **UTC 字面量**
 * 落进 DATETIME 列（`2026-10-18T06:00:00Z` → 库里 `2026-10-18 06:00:00`），
 * 而旧系统 Laravel `now()`（app.timezone=Asia/Shanghai）落的是北京时间墙钟。
 * ⇒ PHP 侧仍会读这些列的（`v2_order_detail.created_at` 等）必须本函数偏移后再写，
 * 否则新系统写出的行比 PHP 写出的早 8 小时（双跑 diff 会当成数据错）。
 *
 * ⚠ 只用于 DATETIME/TIMESTAMP 列；INT unix 时间戳列（`addtime`/`uptime`）不经过这里。
 */
export function shanghaiWallClock(date: Date): Date {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS);
}
