import { webhook1688LogisticsMessageSchema, type Webhook1688LogisticsMessage } from '@crossbuy/contract';
import type { Db, OrderRepository, Tx } from './repository';

/**
 * 跨域端口（域间禁横向 import——结构化最小接口，组合根用 member/send-order 的
 * service 实现装配；R3 拆分时换成注册表解析）。
 */
export interface OauthUserPort {
  findOrCreateOauthUser(input: {
    appid: string;
    openid: string;
    username: string;
    phone: string | null;
  }): Promise<{ ok: true; value: { uid: number; uname: string; memberid: string | null; email: string | null } } | { ok: false; error: { code: string; message: string } }>;
}

export interface SendOrderPort {
  createFor1688Logistics(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    oids: number[];
    receiver: { regionName?: string; detailAddress?: string };
  }): Promise<{ sid: number }>;
}

/**
 * 1688 物流服务商入站 webhook 编排（旧 OrderController::webhookFor1688LogisticsProvider 1:1）。
 *
 * 跨域装配（R3 拆分搬运单元）：
 * - 用户查询/建档 → member service（v2_oauth_login / dg_users 属主）
 * - 运单建档 → send-order service（dg_sendorder 属主）
 * - 订单/入库登记 → 本域 repository（dg_order / v2_logistic_domestic / relation 属主）
 *
 * 旧流程 1:1：tryGetUser → tryGetOrders（空则直建 state=3 订单 + 运单）→
 * expressno 多单号合并 → DgArrival firstOrCreate + pivot 同步 → 转发消息（production）。
 * 失败面：旧代码整条无事务、失败即 500（1688 重试）；这里保持同语义（错误上抛由路由转 500）。
 */
export interface Webhook1688LogisticsDeps {
  repository: OrderRepository;
  /** 旧 env('ALIBABA_LOGISTICS_APPID')——注入（组合根读 env，域内禁直读） */
  appid: string;
  memberService: OauthUserPort;
  sendOrderService: SendOrderPort;
  /**
   * 消息转发端口（旧 production-only POST 到 frp 内网穿透端点；R1 由组合根按 env 决定，
   * 默认 no-op——转发失败旧代码也只 Log 不阻断）。
   */
  forwardMessage?: (message: Webhook1688LogisticsMessage) => Promise<void>;
}

/** 旧 ALIBABA_LOGISTICS_APPID（env 注入，禁硬编码） */
export type Webhook1688LogisticsResult = {
  /** 处理分支（观测用；不影响响应体） */
  outcome: 'existing_orders' | 'created_orders';
  oids: number[];
  sid: number | null;
  arrivalId: number;
};

export class Webhook1688LogisticsService {
  constructor(protected readonly deps: Webhook1688LogisticsDeps) {}

  /**
   * 消费入口。message 先过契约白名单（缺字段 = 调用方 400）；
   * 业务异常上抛（旧代码同语义，路由转 500 让 1688 重试）。
   */
  async consume(message: unknown): Promise<Webhook1688LogisticsResult> {
    const msg = webhook1688LogisticsMessageSchema.parse(message);
    const db = this.deps.repository.db;

    // ① tryGetUser：oauth 命中或建档（member 域）
    const userResult = await this.deps.memberService.findOrCreateOauthUser({
      appid: this.deps.appid,
      openid: msg.buyerUserParam.buyerUserId,
      username: msg.buyerUserParam.username,
      phone: msg.buyerUserParam.phone ?? null,
    });
    if (!userResult.ok) throw new Error(`oauth user provisioning failed: ${userResult.error.code}`);
    const user = userResult.value;

    // ② tryGetOrders：按 tid 查；空则直建 state=3 订单 + 运单（旧建单即入库状态）
    let orders = await this.deps.repository.listByTid(db, msg.tradeOrderId);
    let sid: number | null = null;
    if (orders.length === 0) {
      const created = await this.deps.repository.createZhuanyunOrders(db, {
        tid: msg.tradeOrderId,
        uid: user.uid,
        uname: user.uname,
        items: msg.itemList,
        expressno: msg.mailNo,
      });
      orders = created;
      // 建运单（send-order 域）+ 回写 order.sid（order 域属主写 dg_order）
      const sendOrder = await this.deps.sendOrderService.createFor1688Logistics({
        uid: user.uid,
        uname: user.uname,
        memberid: user.memberid,
        email: user.email,
        oids: created.map((o) => o.oid),
        receiver: msg.receiverAddress,
      });
      await this.deps.repository.attachSid(db, created.map((o) => o.oid), sendOrder.sid);
      sid = sendOrder.sid;
    }

    // ③ expressno 多单号合并（旧：以**首单**现有单号集合为基准；已含 mailNo 则跳过）
    // 旧代码 itemList 空时 Order::insert([]) 直接抛错（Laravel 行为）——同语义 fail-fast
    if (orders.length === 0) throw new Error('1688 logistics webhook: no orders after provisioning');
    const first = orders[0]!;
    const nos = first.expressno === null || first.expressno === '' ? [] : first.expressno.split(' ');
    if (!nos.includes(msg.mailNo)) {
      nos.push(msg.mailNo);
      await this.deps.repository.updateExpressno(db, orders.map((o) => o.oid), nos.join(' '));
    }

    // ④ 入库登记：DgArrival::firstOrCreateRecord（state=1 SEND；type 缺省 1 店铺发货）
    //    + pivot syncWithoutDetaching（唯一键冲突忽略，created_at=now）
    const arrival = await this.deps.repository.firstOrCreateArrival(db, {
      expressno: msg.mailNo,
      providerCode: msg.cpCode,
      state: 1,
      type: 1,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    for (const order of orders) {
      await this.deps.repository.attachArrivalOrder(db, arrival.id, order.oid, nowSec);
    }

    // ⑤ 转发消息（旧 production-only；失败只留痕不阻断——转发端口实现方负责）
    if (this.deps.forwardMessage) {
      await this.deps.forwardMessage(msg);
    }

    return {
      outcome: sid !== null ? 'created_orders' : 'existing_orders',
      oids: orders.map((o) => o.oid),
      sid,
      arrivalId: arrival.id,
    };
  }
}

/** 事务句柄重导出（本文件未用，供后续分片延用；防未用导入告警） */
export type WebhookTx = Tx;
