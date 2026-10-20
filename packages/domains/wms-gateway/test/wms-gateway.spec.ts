import { describe, expect, it } from 'vitest';
import {
  WMS_COMMAND_KIND,
  WMS_FACT_KIND,
  type WmsCommand,
  type WmsFact,
  type WmsStateMapping,
} from '@crossbuy/contract';

import { WmsGatewayServiceImpl } from '../src/service';
import type { WmsCommandPort, WmsEventDeduper, WmsOrderStatePort } from '../src/ports';

// ---------------------------------------------------------------------------
// 内存 fake（纯单测：不连 DB / Redis；组合根才接 @crossbuy/cache 与 order 域）
// ---------------------------------------------------------------------------

class MemoryDeduper implements WmsEventDeduper {
  private readonly marks = new Map<string, number>();
  async claim(key: string, ttlMs: number): Promise<boolean> {
    if (this.marks.has(key)) return false;
    this.marks.set(key, ttlMs);
    return true;
  }
  async forget(key: string): Promise<void> {
    this.marks.delete(key);
  }
  has(key: string): boolean {
    return this.marks.has(key);
  }
}

class RecordingOrderStatePort implements WmsOrderStatePort {
  readonly calls: Array<{
    oid: number;
    toState: number;
    fromStates: number[];
    eventId: string;
    kind: string;
    occurredAt: string;
  }> = [];
  /** 下一次调用的返回（默认成功且 applied） */
  next: { ok: true; applied: boolean } | { ok: false; code: string; message: string } = {
    ok: true,
    applied: true,
  };
  async applyWmsStateChange(input: {
    oid: number;
    toState: number;
    fromStates: number[];
    eventId: string;
    kind: string;
    occurredAt: string;
  }): Promise<
    | { ok: true; value: { applied: boolean } }
    | { ok: false; error: { code: string; message: string } }
  > {
    this.calls.push({ ...input });
    if (this.next.ok) return { ok: true, value: { applied: this.next.applied } };
    return { ok: false, error: { code: this.next.code, message: this.next.message } };
  }
}

class RecordingCommandPort implements WmsCommandPort {
  readonly commands: WmsCommand[] = [];
  nextError: Error | null = null;
  async dispatch(command: WmsCommand): Promise<void> {
    if (this.nextError) throw this.nextError;
    this.commands.push(command);
  }
}

/** P0.2 产出前的示例映射（测试注入用；生产正本 = state-map.ts 的 WMS_STATE_MAP） */
const SAMPLE_MAP: WmsStateMapping[] = [
  { kind: WMS_FACT_KIND.ARRIVAL, wmsStatus: 'IN_WMS', toState: 4, fromStates: [2, 3] },
];

function makeService(opts?: { stateMap?: WmsStateMapping[] }) {
  const deduper = new MemoryDeduper();
  const orderState = new RecordingOrderStatePort();
  const commandPort = new RecordingCommandPort();
  const service = new WmsGatewayServiceImpl({
    deduper,
    orderState,
    commandPort,
    stateMap: opts?.stateMap ?? SAMPLE_MAP,
  });
  return { service, deduper, orderState, commandPort };
}

function makeFact(overrides?: Partial<WmsFact>): WmsFact {
  return {
    eventId: 'evt-1',
    kind: WMS_FACT_KIND.ARRIVAL,
    oid: 101,
    wmsStatus: 'IN_WMS',
    occurredAt: '2026-10-20T12:00:00+08:00',
    raw: { hello: 'heizhou' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 事实面（黑舟 → dg_order）
// ---------------------------------------------------------------------------

describe('wms-gateway 事实面 handleFact', () => {
  it('映射命中 → 调 order 端口一次，入参带 toState/fromStates/oid/eventId/occurredAt', async () => {
    const { service, orderState } = makeService();

    const r = await service.handleFact(makeFact());

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ applied: true, duplicate: false });
    expect(orderState.calls).toHaveLength(1);
    expect(orderState.calls[0]).toMatchObject({
      oid: 101,
      toState: 4,
      fromStates: [2, 3],
      eventId: 'evt-1',
      kind: WMS_FACT_KIND.ARRIVAL,
      occurredAt: '2026-10-20T12:00:00+08:00',
    });
  });

  it('同一 eventId 重复投递 → duplicate=true，order 端口不二次调用（幂等）', async () => {
    const { service, orderState } = makeService();

    const first = await service.handleFact(makeFact());
    const second = await service.handleFact(makeFact());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toEqual({ applied: false, duplicate: true });
    expect(orderState.calls).toHaveLength(1);
  });

  it('未映射事件 → WMS_STATE_UNMAPPED fail-fast，不烧幂等键（补映射后同 eventId 可重投成功）', async () => {
    const { service, deduper, orderState } = makeService({ stateMap: [] });

    const r = await service.handleFact(makeFact());

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('WMS_STATE_UNMAPPED');
    expect(orderState.calls).toHaveLength(0);
    expect(deduper.has('wms:event:evt-1')).toBe(false);

    // 映射补充到位后（P0.2 产出），同一事件重投应正常处理
    const filled = new WmsGatewayServiceImpl({
      deduper,
      orderState,
      commandPort: new RecordingCommandPort(),
      stateMap: SAMPLE_MAP,
    });
    const retried = await filled.handleFact(makeFact());
    expect(retried.ok).toBe(true);
    expect(orderState.calls).toHaveLength(1);
  });

  it('order 端口失败 → 错误透出且幂等键已 forget（重投可再试，仿 worker 渠道失败先 forget）', async () => {
    const { service, deduper, orderState } = makeService();
    orderState.next = { ok: false, code: 'ORDER_NOT_FOUND', message: '订单不存在' };

    const r = await service.handleFact(makeFact());

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('WMS_ORDER_STATE_REJECTED');
      expect(r.error.message).toContain('ORDER_NOT_FOUND');
    }
    expect(deduper.has('wms:event:evt-1')).toBe(false);

    // 重投：端口恢复后成功
    orderState.next = { ok: true, applied: true };
    const retried = await service.handleFact(makeFact());
    expect(retried.ok).toBe(true);
    expect(orderState.calls).toHaveLength(2);
  });

  it('order 端口 cas 未命中（applied:false）→ ok 且 duplicate=false（事件迟到不报错）', async () => {
    const { service, orderState } = makeService();
    orderState.next = { ok: true, applied: false };

    const r = await service.handleFact(makeFact());

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ applied: false, duplicate: false });
    expect(orderState.calls).toHaveLength(1);
  });

  it('状态驱动型事实缺 oid → WMS_EVENT_INVALID，order 端口零调用且不烧幂等键', async () => {
    const { service, orderState, deduper } = makeService();

    const r = await service.handleFact(makeFact({ oid: undefined }));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('WMS_EVENT_INVALID');
    expect(orderState.calls).toHaveLength(0);
    expect(deduper.has('wms:event:evt-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 指令面（本仓 → 黑舟）
// ---------------------------------------------------------------------------

describe('wms-gateway 指令面 dispatchCommand', () => {
  it('指令透传 command port 一次', async () => {
    const { service, commandPort } = makeService();
    const command: WmsCommand = { kind: WMS_COMMAND_KIND.OUTBOUND, oid: 101 };

    const r = await service.dispatchCommand(command);

    expect(r.ok).toBe(true);
    expect(commandPort.commands).toEqual([command]);
  });

  it('port 抛错 → WMS_COMMAND_FAILED（message 带原因，不裸抛）', async () => {
    const { service, commandPort } = makeService();
    commandPort.nextError = new Error('黑舟连接超时');

    const r = await service.dispatchCommand({ kind: WMS_COMMAND_KIND.CANCEL, oid: 101 });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('WMS_COMMAND_FAILED');
      expect(r.error.message).toContain('黑舟连接超时');
    }
  });
});
