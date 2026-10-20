import type { WmsFactKind, WmsStateMapping } from '@crossbuy/contract';

/**
 * 状态映射表（「黑舟状态 ↔ `dg_order.state`」，haiou 11 号 §0.2）。
 *
 * ⚠ **当前为空 = 骨架态（有意为之）**：映射内容等 haiou 前置期 P0.1《WMS 剥离边界表》+
 * P0.2 状态映射表产出后逐条填充（TODO(#20)），黑舟状态码 1:1 抄录、禁本仓自造。
 * 未命中走 `WMS_STATE_UNMAPPED` fail-fast——**禁静默忽略**（haiou 11 号 §0.2：
 * 无法映射的差异必须显式登记）；也禁「先加宽映射让事件跑起来」的临期手熟。
 */
export const WMS_STATE_MAP: readonly WmsStateMapping[] = [
  // TODO(#20): haiou 前置期 P0.2 产出后逐条登记（kind + wmsStatus → toState + fromStates），
  // 每条登记须同步《WMS 剥离边界表》条目号，逐条对账零差异后才允许切写。
];

/** 按（事件族, 黑舟状态码）精确查映射；未命中返回 null（调用方 fail-fast） */
export function resolveStateMapping(
  map: readonly WmsStateMapping[],
  kind: WmsFactKind,
  wmsStatus: string,
): WmsStateMapping | null {
  return map.find((m) => m.kind === kind && m.wmsStatus === wmsStatus) ?? null;
}
