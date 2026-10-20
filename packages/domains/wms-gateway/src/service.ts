import type { WmsCommand, WmsFact, WmsStateMapping } from '@crossbuy/contract';
import { err, ok, type Result } from '@crossbuy/utils';

import { wmsGatewayError, type WmsGatewayError } from './errors';
import type { WmsCommandPort, WmsEventDeduper, WmsOrderStatePort } from './ports';
import { resolveStateMapping, WMS_STATE_MAP } from './state-map';

/**
 * 黑舟 WMS 适配层（docs/04 §3.1；2026-10-20 骨架，TODO(#20) 协议定版后接线）。
 *
 * WMS 业务本体已外迁黑舟（haiou 11 号 §0），本域只做两层薄事：
 *   ① 事实面 `handleFact`：黑舟事件 → 幂等 → 状态映射（fail-fast）→ order 域端口 cas
 *      推进 `dg_order` 仓储状态——order/logistics 域切写后写方从 PHP 适配层移交本仓，
 *      须与域切写同窗口就绪（docs/04 §5.6）
 *   ② 指令面 `dispatchCommand`：本仓 → 黑舟（入库通知/出库发货指令/取消回改）
 *
 * 纪律：
 * - 处理顺序 = 映射/校验（纯）→ 幂等抢占 → 副作用：**先烧幂等键后失败会吞重投**
 *   （协议错译修复后同一事件再也进不来），端口失败先 forget 再 err（同 worker 既定模式）
 * - 重复投递 = ok({duplicate:true})，不是错误（haiou 11 号 §0.2：重复投递不产生副作用）
 * - 迟到事件（cas 未命中 applied:false）= ok 不报错，留痕交给组合根结构化日志
 * - 本域不持表（仓储表外迁黑舟停写）；原始报文 raw 由组合根落结构化日志（docs/07 §5-3，
 *   R2 迁事件表），事务边界不在本域
 */
export interface WmsGatewayService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'wms-gateway';

  /** 事实回传入口（黑舟 → `dg_order` 仓储状态） */
  handleFact(
    fact: WmsFact,
  ): Promise<Result<{ applied: boolean; duplicate: boolean }, WmsGatewayError>>;

  /** 指令下发（本仓 → 黑舟） */
  dispatchCommand(command: WmsCommand): Promise<Result<{ dispatched: true }, WmsGatewayError>>;
}

export interface WmsGatewayDeps {
  /** 事件幂等（组合根接 @crossbuy/cache IdempotencyStore） */
  deduper: WmsEventDeduper;
  /** 订单状态应用（组合根适配 order 域 service） */
  orderState: WmsOrderStatePort;
  /** 黑舟指令客户端（协议定版前组合根给显式 stub） */
  commandPort: WmsCommandPort;
  /** 状态映射表（默认 WMS_STATE_MAP 正本；测试注入样例） */
  stateMap?: readonly WmsStateMapping[];
  /** 幂等标记 TTL：须远大于黑舟重投最大窗口（默认 30 天，同 worker orderCreated 口径） */
  dedupeTtlMs?: number;
}

const DEFAULT_DEDUPE_TTL_MS = 30 * 24 * 3600 * 1000;

export class WmsGatewayServiceImpl implements WmsGatewayService {
  readonly domain = 'wms-gateway' as const;

  private readonly stateMap: readonly WmsStateMapping[];
  private readonly dedupeTtlMs: number;

  constructor(protected readonly deps: WmsGatewayDeps) {
    this.stateMap = deps.stateMap ?? WMS_STATE_MAP;
    this.dedupeTtlMs = deps.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  }

  async handleFact(
    fact: WmsFact,
  ): Promise<Result<{ applied: boolean; duplicate: boolean }, WmsGatewayError>> {
    // ① 状态映射（纯判定）：未命中 fail-fast，不烧幂等键——映射修复后同一事件可重投
    const mapping = resolveStateMapping(this.stateMap, fact.kind, fact.wmsStatus);
    if (!mapping) {
      return err(
        wmsGatewayError(
          'WMS_STATE_UNMAPPED',
          `kind=${fact.kind} wmsStatus=${fact.wmsStatus} 未登记《WMS 剥离边界表》映射（TODO(#20)），禁静默忽略`,
        ),
      );
    }

    // ② 归一化校验：状态驱动型事实必须带订单（纯判定，同样不烧幂等键）
    if (fact.oid === undefined) {
      return err(
        wmsGatewayError('WMS_EVENT_INVALID', `eventId=${fact.eventId} 缺 oid，无法驱动订单状态`),
      );
    }

    // ③ 幂等抢占：重复投递直接短路（副作用零重复）
    const dedupeKey = `wms:event:${fact.eventId}`;
    const claimed = await this.deps.deduper.claim(dedupeKey, this.dedupeTtlMs);
    if (!claimed) {
      return ok({ applied: false, duplicate: true });
    }

    // ④ order 域端口 cas 推进；失败先 forget 放行重投再 err
    const applied = await this.deps.orderState.applyWmsStateChange({
      oid: fact.oid,
      toState: mapping.toState,
      fromStates: mapping.fromStates,
      eventId: fact.eventId,
      kind: fact.kind,
      occurredAt: fact.occurredAt,
    });
    if (!applied.ok) {
      await this.deps.deduper.forget(dedupeKey);
      return err(
        wmsGatewayError(
          'WMS_ORDER_STATE_REJECTED',
          `eventId=${fact.eventId} oid=${fact.oid}：${applied.error.code} ${applied.error.message}`,
        ),
      );
    }
    return ok({ applied: applied.value.applied, duplicate: false });
  }

  async dispatchCommand(
    command: WmsCommand,
  ): Promise<Result<{ dispatched: true }, WmsGatewayError>> {
    try {
      await this.deps.commandPort.dispatch(command);
      return ok({ dispatched: true });
    } catch (e) {
      return err(
        wmsGatewayError(
          'WMS_COMMAND_FAILED',
          `kind=${command.kind} oid=${command.oid}：${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }
}
