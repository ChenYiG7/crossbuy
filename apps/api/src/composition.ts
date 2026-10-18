import {
  ChromeService,
  OrderRepository,
  record1688Snapshot,
  runInOrderTransaction,
  ShipmentService,
  Webhook1688Service,
  Webhook1688LogisticsService,
  type AlibabaOrderClient,
  type AlibabaOrderDetailPort,
  type OauthUserPort,
  type SendOrderPort,
} from '@crossbuy/domain-order';
import { InMemoryLoginRateLimiter, Md5PasswordVerifier, MemberRepository, MemberServiceImpl } from '@crossbuy/domain-member';
import { AdminRepository, AdminServiceImpl, BcryptPasswordVerifier, type AdminService } from '@crossbuy/domain-admin';
import { SendOrderRepository, SendOrderServiceImpl } from '@crossbuy/domain-send-order';

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

// ---------------------------------------------------------------------------
// 1688 物流建档 webhook（跨域装配：member 建档 + send-order 建单 + order 编排）
// ---------------------------------------------------------------------------

let webhook1688Logistics: Webhook1688LogisticsService | null = null;

export function getWebhook1688LogisticsService(): Webhook1688LogisticsService {
  webhook1688Logistics ??= (() => {
    const repo = new OrderRepository();
    // 跨域端口（组合根承边界——app 组合多域是 docs/04 既定模式）
    const memberService: OauthUserPort = new MemberServiceImpl(
      new MemberRepository(),
      new Md5PasswordVerifier(),
      new InMemoryLoginRateLimiter(),
    );
    const sendOrderService: SendOrderPort = new SendOrderServiceImpl(
      new SendOrderRepository(),
      // 订单读端口（dg_order 属主 = order 域；运单列表订单面依赖）
      (() => {
        const orderRepo = new OrderRepository();
        return {
          listBriefBySids: (sids) => orderRepo.listBriefBySids(orderRepo.db, sids),
          listSidsByShipmentKeyword: (uid, keyword, isDf) => orderRepo.listSidsByShipmentKeyword(orderRepo.db, uid, keyword, isDf),
        };
      })(),
      // 物流查询网址端口（SystemSetting 迁移前缺省 null → Google 搜索兜底，旧语义）
      { resolve: () => null },
    );
    return new Webhook1688LogisticsService({
      repository: repo,
      appid: process.env.ALIBABA_LOGISTICS_APPID ?? '',
      memberService,
      sendOrderService,
      // R1 转发端口：env 开启（旧 APP_ENV=production 同款）；失败只留痕不阻断
      forwardMessage: process.env.WEBHOOK_1688_LOGISTICS_FORWARD_URL
        ? async (message) => {
            await fetch(process.env.WEBHOOK_1688_LOGISTICS_FORWARD_URL!, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(message),
            }).catch(() => undefined);
          }
        : undefined,
    });
  })();
  return webhook1688Logistics;
}

// ---------------------------------------------------------------------------
// chrome 插件回传（旧 webhooks/chrome：后台登录态 + 订单域写路径）
// ---------------------------------------------------------------------------

/** 后台身份/登录域（chrome 回传只用到 getIdentity） */
let adminService: AdminService | null = null;

export function getAdminService(): AdminService {
  adminService ??= new AdminServiceImpl(new AdminRepository(), new BcryptPasswordVerifier());
  return adminService;
}

/** 最小日志端口（Fastify 的 pino 实例即满足；域层不感知 pino 类型） */
export interface RiskLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** chrome 回传的 1688 详情端口：SDK 未迁移 → 恒 null（= 旧 !isSuccess 分支，S48） */
const notImplementedChromeAlibaba: AlibabaOrderDetailPort = {
  async getOrderDetail() {
    return null;
  },
};

let chromeService: ChromeService | null = null;

/**
 * chrome 回传组合根。
 *
 * 装配说明：
 * - `shipment` = 发货回传（旧 ACTION_SAVE_EXPRESS）——同一入口按 action 分流
 * - `recordSnapshot` = 平台金额快照（旧 PlatformOrderAmountSnapshotService::record1688）
 * - `riskLog` = 旧 `Log::channel('webhook_1688')->warning`（风控阻断留痕）
 * - `auditLog` = 旧 `Log::channel('order_update')` + admin_operation_log（R1 只留痕不落表）
 */
export function getChromeService(log: RiskLogger): ChromeService {
  chromeService ??= (() => {
    const repo = new OrderRepository();
    return new ChromeService({
      repository: repo,
      alibaba: notImplementedChromeAlibaba,
      recordSnapshot: async (tid, detail, stage) => {
        await record1688Snapshot(repo.db, tid, detail as Record<string, unknown>, stage, new Date());
      },
      shipment: new ShipmentService({
        repository: repo,
        runTx: runInOrderTransaction,
        now: () => new Date(),
      }),
      riskLog: (info) => {
        const { channel, message, ...rest } = info as { channel?: string; message?: string } & Record<string, unknown>;
        log.warn({ channel, ...rest }, message ?? 'chrome webhook risk control');
      },
      auditLog: (info) => {
        log.warn({ channel: 'order_update', ...info }, 'chrome order update');
      },
      runTx: runInOrderTransaction,
      now: () => new Date(),
    });
  })();
  return chromeService;
}
