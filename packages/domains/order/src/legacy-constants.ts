/**
 * 旧系统硬编码业务常量（Order.php / User.php / Record.php 1:1）。
 *
 * ⚠ `$dfConfigs` 在旧代码是**类内静态数组**（不是配置文件）——R1 一律原样硬编码；
 * 将它们做成可配置 = 行为变更，灰度期双跑会 diff。收敛到配置中心是 R2 的事。
 */
import type { OrderStatusCode } from '@crossbuy/contract';
import { OrderStatus, OrderType } from '@crossbuy/contract';

/** Order::$dfConfigs（旧 Order.php:74-79，全部为代码内字面量）；类型放宽为 number 便于分支比较 */
export const DF_CONFIGS: Record<'DFCHARGE' | 'ISAMTLIMIT' | 'AMTLIMIT' | 'AMTLIMITFEE', number> = {
  DFCHARGE: 15.0,
  ISAMTLIMIT: 0,
  AMTLIMIT: 200,
  AMTLIMITFEE: 1.05,
};

/** Order::$orderFlags —— dg_record.ordflag 的交易标示 */
export const ORDER_FLAGS = { DG: 1, ZS: 2, DF: 3 } as const;

/** Record 常量（旧 Record.php） */
export const RECORD = {
  /** Record::TYPE_DECR */
  TYPE_DECR: 1,
  /** Record::TYPE_INCR */
  TYPE_INCR: 2,
  /** Record::RECORD_ACTION_4（返金/收入动作——action 词表随对账域补全） */
  ACTION_4: 4,
  ORDER_FLAG_1: 1,
  ORDER_FLAG_3: 3,
} as const;

/** User::UTYPE_* */
export const UTYPE = { COMMON: 0, CHARGED: 1 } as const;

/** User::DF_FLAG_1（dfflag 位） */
export const DF_FLAG_1 = 1;

/** 金额计算排除态（旧 Order::$invalidStates = [6, 10, 11]） */
export const INVALID_STATES: readonly OrderStatusCode[] = [
  OrderStatus.INVALID,
  OrderStatus.INVALID_REFUNDED,
  OrderStatus.INVALID_DISUSED,
];

/** 订单类型（旧 ORDER_TYPE_*） */
export const ORDER_TYPE = {
  DAIGOU: OrderType.PURCHASE,
  ZHUANYUN: OrderType.TRANSFER,
  DAIFA: OrderType.ONE_PIECE,
} as const;
