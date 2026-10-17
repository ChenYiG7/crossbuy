import type { PlatformSnapshotStage, Webhook1688Ack, Webhook1688Message } from '@crossbuy/contract';
import type { Db } from './repository';

/**
 * 1688 开放平台订单客户端端口（旧 resolveAlibabaSdkByTradeId + getOrderDetail）。
 *
 * R1：真实 HTTP 实现随 1688 SDK 迁移落地（appKey/secret 走 env，apps/api 组合根注入）；
 * 本端口让 webhook 分发逻辑可单测（stub 拉取详情）。禁把 SDK 类型泄漏进域。
 */
export interface AlibabaOrderClient {
  /** 拉取 1688 订单详情（旧 TradeInfoGetRequest；失败 = null，由调用方 markFailed(retryable)） */
  getOrderDetail(tid: string): Promise<Record<string, unknown> | null>;
}

/** 事件处理结果（service 层；HTTP 状态码映射在 apps/api 路由） */
export interface Webhook1688Outcome {
  ack: Webhook1688Ack;
  /** true = 503（retryable）；false = 200（旧 $httpStatus 语义） */
  retryable: boolean;
}

/** 旧 parsePayTime 1:1：空 → now；13 位毫秒 → 秒；YmdHisvO → 秒；其余 Date.parse 兜底 → 失败回 now */
export function parsePayTime(payTime: unknown, now: Date = new Date()): number {
  if (payTime === null || payTime === undefined || payTime === '') {
    return Math.floor(now.getTime() / 1000);
  }
  if (typeof payTime === 'number' || (typeof payTime === 'string' && /^-?\d+$/.test(payTime))) {
    const n = Number(payTime);
    return n > 9_999_999_999 ? Math.floor(n / 1000) : n;
  }
  if (typeof payTime === 'string') {
    // 旧 DateTime::createFromFormat('YmdHisvO')：20250117123456789+0900 形态
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})([+-]\d{4})$/.exec(payTime);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      const h = Number(m[4]);
      const mi = Number(m[5]);
      const s = Number(m[6]);
      const ms = Number(m[7]);
      const tz = m[8] ?? '+0000';
      const sign = tz.startsWith('-') ? -1 : 1;
      const tzMin = Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5));
      const utcMs = Date.UTC(y, mo - 1, d, h, mi, s, ms);
      return Math.floor((utcMs - sign * tzMin * 60 * 1000) / 1000);
    }
    const parsed = Date.parse(payTime.replace(' ', 'T'));
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(now.getTime() / 1000);
}

/** 旧 Order::TYPE_1688 goodssite 守卫值 */
export const GOODS_SITE_1688 = '1688';
/** 旧 Order::ORDER_TYPE_DAIGOU */
export const ORDER_TYPE_DAIGOU = 1;

export interface Webhook1688Deps {
  /** 快照写入（platform-snapshot.record1688Snapshot；失败不阻断推进——旧 record1688 语义） */
  recordSnapshot: (db: Db, tid: string, detail: Record<string, unknown>, stage: PlatformSnapshotStage, now: Date) => Promise<boolean>;
  /** update1688PaidOrders（repository 条件 UPDATE；单语句原子，db=单例连接或 batch 事务句柄） */
  update1688PaidOrders: (db: Db, tid: string, payTimeSec: number, nowSec: number) => Promise<number>;
  /** 批量事件事务运行器（apps/api 注入 $transaction；单事件分支不用） */
  runTx: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  alibaba: AlibabaOrderClient;
  /** 默认连接句柄（repository.db；快照/单事件 UPDATE 用） */
  db: Db;
  now: () => Date;
}

/**
 * 1688 支付 webhook 分发（旧 OrderController::webhookFor1688 支付面 1:1）。
 *
 * 已处理事件：ORDER_BUYER_VIEW_ORDER_PAY / ORDER_BUYER_VIEW_ORDER_STEP_PAY /
 * ORDER_BATCH_PAY —— 三个支付事件都收敛到 update1688PaidOrders（条件 UPDATE 范本，
 * S19 三处之一）。幂等性 = 条件 UPDATE 本身（state 已进 2 的行不再匹配，重投递无副作用）。
 *
 * ⚠ 差异登记（S24）：ORDER_BUYER_VIEW_BUYER_MAKE（建单事件）依赖 Job 管线
 * （SnapshotPlatformOrderAmountOnCreated + 300 秒延迟 ProcessOrderAutoCreatedFromHandle），
 * R1 worker Job 迁移前返回 success + reason='job pipeline pending'——事件不丢（1688 不重试
 * 200 响应），行为差异是「快照与自动建单延后」，不是状态错误。
 *
 * 事务边界差异（有意，1:1 核对）：旧 PAY/STEP_PAY 分支**无外层事务**
 * （update1688PaidOrders 自带 begin/commit，单语句原子等价）；BATCH 分支整批一个事务，
 * 任一失败回滚整批——runTx 只在 batch 用。
 */
export class Webhook1688Service {
  constructor(private readonly deps: Webhook1688Deps) {}

  async handle(message: Webhook1688Message): Promise<Webhook1688Outcome> {
    const { type } = message;
    const data = (message.data ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'ORDER_BUYER_VIEW_ORDER_PAY':
        return this.handlePay(data);
      case 'ORDER_BUYER_VIEW_ORDER_STEP_PAY':
        return this.handleStepPay(data);
      case 'ORDER_BATCH_PAY':
        return this.handleBatchPay(data);
      case 'ORDER_BUYER_VIEW_BUYER_MAKE':
        return this.ok(type, 'job pipeline pending');
      default:
        // 未知事件：旧 switch 无 default 分支 = 静默 success（1:1）
        return this.ok(type);
    }
  }

  /** 旧 ORDER_BUYER_VIEW_ORDER_PAY 分支 1:1 */
  private async handlePay(data: Record<string, unknown>): Promise<Webhook1688Outcome> {
    const type = 'ORDER_BUYER_VIEW_ORDER_PAY';
    const tid = data.orderId;
    if (typeof tid !== 'string' || tid === '') {
      return this.fail(`${type}: tid is empty`, false);
    }
    if (data.currentStatus !== 'waitsellersend') {
      // 状态不符：旧代码 break = success 无 reason（1:1 静默忽略）
      return this.ok(type);
    }
    return this.fetchAndRecord(type, tid);
  }

  /** 旧 ORDER_BUYER_VIEW_ORDER_STEP_PAY 分支 1:1（分期付款：全款到账才推进） */
  private async handleStepPay(data: Record<string, unknown>): Promise<Webhook1688Outcome> {
    const type = 'ORDER_BUYER_VIEW_ORDER_STEP_PAY';
    const tid = data.orderId;
    if (typeof tid !== 'string' || tid === '') {
      return this.fail(`${type}: tid is empty`, false);
    }
    if (data.currentStatus !== 'waitsellersend') {
      return this.ok(type);
    }
    const detail = await this.deps.alibaba.getOrderDetail(tid);
    if (detail === null) {
      return this.fail(`${type}: getOrderDetail failed`, true);
    }
    await this.deps.recordSnapshot(this.deps.db, tid, detail, 'paid', this.deps.now());
    const base = (detail.baseInfo ?? {}) as Record<string, unknown>;
    const stepList = Array.isArray(base.newStepOrderList) ? (base.newStepOrderList as Array<Record<string, unknown>>) : [];
    let payTimeRaw: unknown = base.payTime ?? null;
    for (const step of stepList) {
      if (step.payStatus !== 2) {
        return this.fail(`${type}: step not fully paid`, false);
      }
      const gmtPay = step.gmtPay;
      const hasPay = payTimeRaw !== null && payTimeRaw !== '';
      const gmt = gmtPay !== undefined && gmtPay !== null && gmtPay !== '' ? String(gmtPay) : null;
      if (!hasPay && gmt !== null) {
        payTimeRaw = gmt;
      } else if (gmt !== null && gmt > String(payTimeRaw ?? '')) {
        payTimeRaw = gmt;
      }
    }
    const payTimeSec = parsePayTime(payTimeRaw, this.deps.now());
    return this.runUpdate(type, tid, payTimeSec);
  }

  /** 旧 ORDER_BATCH_PAY 分支 1:1（整批一个事务；任一失败回滚整批） */
  private async handleBatchPay(data: Record<string, unknown>): Promise<Webhook1688Outcome> {
    const type = 'ORDER_BATCH_PAY';
    const batch = Array.isArray(data.batchPay) ? (data.batchPay as Array<Record<string, unknown>>) : [];
    const failures: Array<{ reason: string; retryable: boolean }> = [];

    try {
      await this.deps.runTx(async (tx) => {
        for (const item of batch) {
          const tid = item.orderId;
          if (typeof tid !== 'string' || tid === '') {
            failures.push({ reason: `${type}: tid is empty`, retryable: false });
            return; // 旧 break → rollBack 路径
          }
          const detail = await this.deps.alibaba.getOrderDetail(tid);
          if (detail === null) {
            failures.push({ reason: `${type}: getOrderDetail failed`, retryable: true });
            return;
          }
          const base = (detail.baseInfo ?? {}) as Record<string, unknown>;
          const payTimeSec = parsePayTime(base.payTime ?? null, this.deps.now());
          await this.deps.update1688PaidOrders(tx, tid, payTimeSec, Math.floor(this.deps.now().getTime() / 1000));
        }
      });
      if (failures.length > 0) {
        return this.fail(failures[0]!.reason, failures[0]!.retryable);
      }
      return this.ok(type);
    } catch {
      return this.fail(`${type}: exception`, true);
    }
  }

  /** 共通尾步：SDK 拉详情 → 快照 → update1688PaidOrders（旧 PAY 分支主体 1:1） */
  private async fetchAndRecord(type: string, tid: string): Promise<Webhook1688Outcome> {
    const detail = await this.deps.alibaba.getOrderDetail(tid);
    if (detail === null) {
      return this.fail(`${type}: getOrderDetail failed`, true);
    }
    await this.deps.recordSnapshot(this.deps.db, tid, detail, 'paid', this.deps.now());
    const base = (detail.baseInfo ?? {}) as Record<string, unknown>;
    const payTimeSec = parsePayTime(base.payTime ?? null, this.deps.now());
    return this.runUpdate(type, tid, payTimeSec);
  }

  private async runUpdate(type: string, tid: string, payTimeSec: number): Promise<Webhook1688Outcome> {
    try {
      await this.deps.update1688PaidOrders(this.deps.db, tid, payTimeSec, Math.floor(this.deps.now().getTime() / 1000));
      return this.ok(type);
    } catch {
      return this.fail(`${type}: db update failed`, true);
    }
  }

  private ok(eventType: string, reason?: string): Webhook1688Outcome {
    return { ack: { success: true, event_type: eventType, ...(reason ? { reason } : {}) }, retryable: false };
  }

  private fail(reason: string, retryable: boolean): Webhook1688Outcome {
    return { ack: { success: false, event_type: '*', retryable, reason }, retryable };
  }
}
