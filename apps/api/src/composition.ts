import {
  OrderRepository,
  record1688Snapshot,
  runInOrderTransaction,
  Webhook1688Service,
  type AlibabaOrderClient,
} from '@crossbuy/domain-order';

/**
 * apps/api 组合根（webhook 面）：域实现在这里接线，路由只拿接口。
 *
 * ⚠ AlibabaOrderClient R1 现状：真实 1688 SDK（签名协议）迁移未完成——默认实现
 * 返回 null（getOrderDetail failed → 503 retryable），即「SDK 不可用 → 上游重试」
 * 的正确语义；SDK 迁移后替换本实现（S24/TODO 登记）。快照/状态推进/信封语义已 1:1。
 */

/** R1 占位客户端：SDK 迁移前恒失败（503 retryable 语义正确） */
const notImplementedAlibabaClient: AlibabaOrderClient = {
  async getOrderDetail() {
    return null;
  },
};

let webhook1688: Webhook1688Service | null = null;

export function getWebhook1688Service(): Webhook1688Service {
  webhook1688 ??= (() => {
    // db 句柄经 repository 出口拿（app 禁直触 @crossbuy/db——ESLint 边界规则）
    const repo = new OrderRepository();
    return new Webhook1688Service({
      db: repo.db,
      alibaba: notImplementedAlibabaClient,
      recordSnapshot: record1688Snapshot,
      update1688PaidOrders: (db, tid, payTimeSec, nowSec) => repo.update1688PaidOrders(db, tid, payTimeSec, nowSec),
      runTx: runInOrderTransaction,
      now: () => new Date(),
    });
  })();
  return webhook1688;
}
