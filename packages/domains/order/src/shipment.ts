import { shipmentChromeSchema, type ShipmentBatchItem, type ShipmentBatchResult, type ShipmentChromeInput } from '@crossbuy/contract';
import type { Db, OrderRepository } from './repository';

/**
 * 发货回传（旧 updateExpressNoForChrome / batchUpdateExpressno 1688·淘宝分支 1:1）。
 *
 * chrome 插件 ACTION_SAVE_EXPRESS 与 1688 发货同步共用「state 2→3 + 单号 + 入库登记」链路：
 * - Order::updateOrder 有效语义子集（state 2→3 无金额字段 → dispatchSync 空转，只 bulk update）
 * - 审计日志（saveBatchUpdateRecord）走 auditLog 端口（S27：webhook 面无 admin 会话）
 * - 入库登记复用 firstOrCreateArrival + attachArrivalOrder（与 1688 物流建档同一对方法）
 */
export interface ShipmentDeps {
  repository: OrderRepository;
  /** 审计日志端口（旧 Log::channel('order_update') + admin_operation_log；R1 默认 no-op） */
  auditLog?: (info: { change: Record<string, unknown>; oids: number[] }) => void;
  /** 事务运行器（webhook 无外层事务——每笔 tid 自起；测试注入 rollback tx） */
  runTx: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  now: () => Date;
}

export class ShipmentService {
  constructor(protected readonly deps: ShipmentDeps) {}

  /** chrome 单笔回传（旧 updateExpressNoForChrome 1:1；返回体形态 1:1 code 200/40000） */
  async updateExpressNoForChrome(input: unknown): Promise<{ code: 200 | 40000; msg?: string }> {
    const parsed = shipmentChromeSchema.safeParse(input);
    if (!parsed.success) {
      return { code: 40000, msg: '参数错误' };
    }
    const { tid, expressNo } = parsed.data satisfies ShipmentChromeInput;
    const db = this.deps.repository.db;

    // 旧 :481 无 goodssite 过滤（1:1）
    const orders = await this.deps.repository.listPaidByTid(db, tid);
    if (orders.length === 0) {
      return { code: 40000, msg: '订单不存在' };
    }
    const oids = orders.map((o) => o.oid);
    const nowSec = Math.floor(this.deps.now().getTime() / 1000);

    try {
      await this.deps.runTx(async (tx) => {
        await this.deps.repository.applyShipment(tx, oids, { state: 3, waytime: nowSec, expressno: expressNo });
        await this.attachArrivalRecords(tx, expressNo.split(' ').map((no) => ({ expressNo: no, companyNo: '' })), oids, nowSec);
      });
    } catch (e) {
      // 旧 rollback → 40000 + error message（1:1）
      return { code: 40000, msg: `更新物流单号失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return { code: 200 };
  }

  /** 批量发货同步（旧 batchUpdateExpressno 1688/淘宝分支 1:1；淘宝全球购 SDK 分支不在本服务） */
  async batchUpdateExpressno(
    items: ShipmentBatchItem[],
    platform = '1688',
    _opts: { isDelayedFix?: boolean } = {}, // isDelayedFix 仅影响旧日志差异（S27），R1 留位
  ): Promise<ShipmentBatchResult> {
    const db = this.deps.repository.db;
    const failedTids: string[] = [];
    const idempotentTids: string[] = [];
    const nowSec = Math.floor(this.deps.now().getTime() / 1000);

    for (const item of items) {
      const tid = item.tid.trim();
      const expressNos = item.express_detail.expressId;

      if (expressNos.length === 0 || tid === '') {
        failedTids.push(tid);
        continue;
      }

      const expressStr = expressNos.map((e) => e.expressNo).join(' ');

      // 已付款 + 单号为空 → 发货推进（state 2→3 + waytime）
      let oids = (await this.deps.repository.listPaidWithoutExpressno(db, tid, platform)).map((o) => o.oid);
      let updateData: { state?: number; waytime?: number; expressno: string };
      if (oids.length === 0) {
        // 已发货 + 单号不一致 → 只改单号（isDelayedFix 日志差异 R1 略——S27）
        oids = (await this.deps.repository.listSentWithDifferentExpressno(db, tid, platform, expressStr)).map((o) => o.oid);
        updateData = { expressno: expressStr };
      } else {
        updateData = { state: 3, waytime: nowSec, expressno: expressStr };
      }

      if (oids.length === 0) {
        // 幂等判定：tid+平台全部订单单号归一化后逐单一致
        const existing = await this.deps.repository.listExpressnoByTidAndPlatform(db, tid, platform);
        const alreadySynced = existing.length > 0 && existing.every((no) => normalizeExpressNoString(`${no ?? ''}`) === normalizeExpressNoString(expressStr));
        if (alreadySynced) {
          idempotentTids.push(tid);
        } else {
          failedTids.push(tid);
        }
        continue;
      }

      try {
        await this.deps.runTx(async (tx) => {
          await this.deps.repository.applyShipment(tx, oids, updateData);
          await this.attachArrivalRecords(tx, expressNos, oids, nowSec);
        });
      } catch {
        // 旧 rollback → failedTids（1:1）
        failedTids.push(tid);
      }
    }

    if (failedTids.length === 0) {
      return { code: 200, data: { failed_tids: [], idempotent_tids: idempotentTids } };
    }
    return {
      code: 40000,
      msg: `以下订单发货状态同步失败，可能是因为订单不存在、本地状态不符合或物流单号不一致：${failedTids.join('、')}`,
      data: { failed_tids: failedTids, idempotent_tids: idempotentTids },
    };
  }

  /** 入库登记（每单号 firstOrCreate + pivot 同步；旧「物流记录和订单状态必须保持一致」注释 1:1） */
  protected async attachArrivalRecords(
    db: Db,
    expressNos: Array<{ expressNo: string; companyNo?: string }>,
    oids: number[],
    nowSec: number,
  ): Promise<void> {
    for (const expressNo of expressNos) {
      const record = await this.deps.repository.firstOrCreateArrival(db, {
        expressno: expressNo.expressNo,
        providerCode: expressNo.companyNo ?? '',
        state: 1, // DgArrival::STATE_SEND
        type: 1, // TYPE_SHOP_DELIVERY 缺省
      });
      for (const oid of oids) {
        await this.deps.repository.attachArrivalOrder(db, record.id, oid, nowSec);
      }
    }
  }
}

/** 旧 normalizeExpressNoString：trim → 去空 → 去重 → 排序 → 空格拼接 */
export function normalizeExpressNoString(expressNo: string): string {
  const parts = expressNo.split(' ').map((p) => p.trim()).filter((p) => p !== '');
  return [...new Set(parts)].sort().join(' ');
}
