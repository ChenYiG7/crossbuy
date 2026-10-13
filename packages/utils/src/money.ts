import Decimal from 'decimal.js';

/**
 * 金额统一用字符串承载，禁止 JS number 参与金额运算（浮点误差是资金事故之源）。
 * 内部算术走 decimal.js 全精度；入库对齐 DECIMAL(12,4)，显示层再按币种格式化。
 * 全项目金额计算只走本模块（单一入口），禁止在别处 `+ - * /` 直接算钱。
 */
export type Money = string;

export type MoneyInput = string | number | Decimal;

export function money(value: MoneyInput): Money {
  return new Decimal(value).toString();
}

export function add(a: Money, b: Money): Money {
  return new Decimal(a).plus(b).toString();
}

export function sub(a: Money, b: Money): Money {
  return new Decimal(a).minus(b).toString();
}

export function mul(a: Money, n: MoneyInput): Money {
  return new Decimal(a).times(n).toString();
}

export function div(a: Money, n: MoneyInput): Money {
  return new Decimal(a).div(n).toString();
}

/** 比较：返回 -1 | 0 | 1 */
export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  return new Decimal(a).comparedTo(b) as -1 | 0 | 1;
}

export function isZero(a: Money): boolean {
  return new Decimal(a).isZero();
}

export function isNegative(a: Money): boolean {
  return new Decimal(a).isNegative();
}

/**
 * 断言非负。账本结存为负 = 数据已坏，必须拒绝动账并回滚，禁止静默归零。
 */
export function assertNonNegative(a: Money, msg = '金额不能为负'): Money {
  if (isNegative(a)) throw new Error(msg);
  return a;
}

export function sum(items: Money[]): Money {
  return items.reduce((acc, m) => add(acc, m), money(0));
}
