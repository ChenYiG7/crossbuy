import type { WmsCommand, WmsFactKind } from '@crossbuy/contract';

/**
 * wms-gateway 域端口（黑舟适配层骨架，2026-10-20；TODO(#20) 协议定版后组合根接线）。
 *
 * 纪律（docs/04 §3.2 / docs/07 §5）：
 * - 域间禁横向 import：`WmsOrderStatePort` 的实现由组合根适配到 order 域 service
 *   （dg_order 属主 = order 域，适配层禁直写订单表）
 * - 基础设施不进域：`WmsEventDeduper` 由组合根接 `@crossbuy/cache` 的 IdempotencyStore
 *   （`SET NX PX` 抢占语义）；黑舟 API 客户端接 `WmsCommandPort`
 * - 外呼在事务外（docs/07 §5-7 AFTER_COMMIT）：本域不开本地事务，端口实现自行管重试
 */

/** 指令下发端口（本仓 → 黑舟；协议定版前组合根给显式 stub，禁静默吞指令） */
export interface WmsCommandPort {
  dispatch(command: WmsCommand): Promise<void>;
}

/**
 * 订单状态应用端口（事实面出口，跨域 → order 域）。
 * 实现方按 docs/07 §4 cas 推进：`UPDATE dg_order SET state=toState WHERE oid=? AND state IN (fromStates)`；
 * `applied:false` = cas 未命中（事件迟到/状态已推进——迟到事件不算失败，由调用方留痕）。
 */
export interface WmsOrderStatePort {
  applyWmsStateChange(input: {
    oid: number;
    toState: number;
    fromStates: number[];
    eventId: string;
    kind: WmsFactKind;
    /** 事件发生时间（ISO；rukutime/peisongtime 类 INT unix 列由 order 域仓储转换） */
    occurredAt: string;
  }): Promise<
    | { ok: true; value: { applied: boolean } }
    | { ok: false; error: { code: string; message: string } }
  >;
}

/**
 * 事件幂等端口（黑舟重复投递不产生副作用，haiou 11 号 §0.2）。
 * `claim` 抢占「已完成」标记：第一次 true、重复 false；处理失败须 `forget`
 * 放行重投（同 worker 渠道失败先 forget 再抛的既定模式）。
 */
export interface WmsEventDeduper {
  claim(key: string, ttlMs: number): Promise<boolean>;
  forget(key: string): Promise<void>;
}
