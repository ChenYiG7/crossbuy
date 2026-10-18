/**
 * order 域金额工具——旧 OrderAmountSyncService::money/moneyEquals 的 Decimal 化复现。
 *
 * 语义对齐：旧 `round((float)$v, 2)` = PHP ROUND_HALF_AWAY_FROM_ZERO；decimal.js 的
 * ROUND_HALF_UP 同义。差异方向：旧计算链在 float 上有浮点噪声（如 0.1+0.2），本实现
 * 全精度无噪声——第 3 位小数出现噪声时**以本实现为准**（有意改善，双跑 diff 判读规则）；
 * 存储层旧列仍是 Float，R2 换 DECIMAL 后天然对齐。
 */
import Decimal from 'decimal.js';

/**
 * 旧 money()：舍入到分。PHP round 半舍入远离零。
 */
export function moneyOf(value: number | string | null | undefined): number {
  return new Decimal(value ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}

/** 舍入到分并返回 Decimal（链上继续运算用，避免中途退化 float） */
export function money(value: number | string | null | undefined): number {
  return moneyOf(value);
}

/** 旧 moneyEquals：按分比较（int(round(l*100)) === int(round(r*100))） */
export function moneyEquals(
  left: number | string | null | undefined,
  right: number | string | null | undefined,
): boolean {
  const l = new Decimal(left ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const r = new Decimal(right ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return l.equals(r);
}
