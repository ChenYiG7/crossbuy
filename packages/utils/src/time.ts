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
