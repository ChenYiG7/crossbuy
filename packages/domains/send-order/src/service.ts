import {
  sendOrderListQuerySchema,
  type Airbill,
  type SendOrderListQuery,
  type SendOrderMemberRow,
} from '@crossbuy/contract';
import { err, ok, type Result } from '@crossbuy/utils';
import { unixToIso } from '@crossbuy/utils';
import type { Principal } from '@crossbuy/auth';
import type { LegacyWhere, SendOrderRepository } from './repository';

/**
 * 订单侧读端口（dg_order 属主 = order 域；send-order 列表的订单面依赖经此消费——
 * 结构化最小接口，组合根装配；域间禁横向 import）。
 */
export interface SendOrderOrdersPort {
  /** sid → 订单摘要（mark_flag/yanhuofba/type/sendprice；arrival/FBA/合计兜底用） */
  listBriefBySids(sids: number[]): Promise<Map<number, Array<{ markFlag: number | null; yanhuofba: string; type: number | null; sendprice: number }>>>;
  /** orderKeyword 反查 sid（六列 like + dfflag type 分流） */
  listSidsByShipmentKeyword(uid: number, keyword: string, isDf: boolean): Promise<number[]>;
}

/** 物流查询网址端口（旧 SystemSetting::get('shipping_website_urls')；缺省回 Google 搜索） */
export interface ShippingWebsitePort {
  resolve(deliveryname: string): string | null;
}

/** 旧 MEMBER_STATE 等常量：运单 DF 默认可见态（旧 :117-120） */
const DF_DEFAULT_STATES = [1, 2, 3, 5];
/** mark_flag arrival 位（旧 Order::MARK_FLAG_ARRIVAL = 2） */
const MARK_FLAG_ARRIVAL_POSITION = 2;

/** round2（PHP round 语义，金额恒正） */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 运单/合包/发货/发票 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：Services/SendOrder*；R3 归属：oms
 */
export interface SendOrderService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'send-order';

  /**
   * 1688 物流建档运单（旧 OrderController::tryGetOrders 尾段 1:1）：
   * STATE_WAITING=1 / OTYPE_3=3「一件代发」/ 全零金额字段 / receiver 直落 address+country。
   * 返回新 sid；回写 dg_order.sid 由调用方（order 域编排，属主写自己表）完成。
   */
  createFor1688Logistics(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    oids: number[];
    receiver: { regionName?: string; detailAddress?: string };
  }): Promise<{ sid: number }>;

  /**
   * 会员运单列表（旧 listSendOrder + SendOrderListInput::buildQuery 1:1）。
   * dfflag 分流（DF=otype3+默认可见态 [1,2,3,5]；普通=otype1）；时间窗过滤 uptime；
   * 不回 total（旧 GraphQL 面 CustomPaginationType 1:1，S29）。
   */
  listMemberSendOrders(
    principal: Principal,
    query: SendOrderListQuery,
    isDf: boolean,
  ): Promise<Result<{ rows: SendOrderMemberRow[]; page: number; pageSize: number }, { code: string; message: string }>>;
}

export class SendOrderServiceImpl implements SendOrderService {
  readonly domain = 'send-order' as const;

  constructor(
    protected readonly repository: SendOrderRepository,
    protected readonly ordersPort: SendOrderOrdersPort,
    protected readonly shippingWebsitePort: ShippingWebsitePort,
  ) {}

  async listMemberSendOrders(
    principal: Principal,
    rawQuery: SendOrderListQuery,
    isDf: boolean,
  ): Promise<Result<{ rows: SendOrderMemberRow[]; page: number; pageSize: number }, { code: string; message: string }>> {
    if (principal.kind !== 'member') {
      return err({ code: 'NO_PERMISSIONS', message: '非会员主体' });
    }
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'NO_PERMISSIONS', message: 'Principal 非法' });
    }
    const query = sendOrderListQuerySchema.parse(rawQuery);
    const db = this.repository.db;

    const AND: NonNullable<LegacyWhere['AND']> = [];
    const where: LegacyWhere = { uid, AND };

    // ---- dfflag 分流（旧 :123-131）：DF=otype3（无 state 时默认可见态）；普通=otype1 ----
    AND.push({ otype: isDf ? 3 : 1 });
    if (isDf && query.state === undefined) {
      AND.push({ state: { in: DF_DEFAULT_STATES } });
    }

    if (query.state !== undefined) AND.push({ state: query.state });
    if (query.sid !== undefined) AND.push({ sid: query.sid });

    // ---- keyword：`数字/数字` → sid IN；否则五列 like（1:1）----
    if (query.keyword) {
      if (/^[0-9]+(\/[0-9]*)+$/.test(query.keyword)) {
        const ids = query.keyword.split('/').map(Number).filter(Number.isInteger);
        AND.push({ sid: { in: ids } });
      } else {
        const kw = { contains: query.keyword };
        // ⚠ 旧 `sid LIKE` 对 Int 列隐式转换——Prisma 无法 LIKE 整数，纯数字时等值、否则跳过（S28 同族）
        const sidFilter = /^\d+$/.test(query.keyword) ? [{ sid: { equals: Number(query.keyword) } }] : [];
        AND.push({ OR: [...sidFilter, { oids: kw }, { address: kw }, { sn: kw }, { consignee: kw }] });
      }
    }

    // ---- orderKeyword：订单侧反查 sid（端口；空集 = Prisma in [] 恒 false，与旧 whereIn 同义）----
    if (query.orderKeyword) {
      const sids = await this.ordersPort.listSidsByShipmentKeyword(uid, query.orderKeyword, isDf);
      AND.push({ sid: { in: sids } });
    }

    // ---- 时间窗：**uptime**（1:1）----
    if (query.startTime !== undefined) AND.push({ uptime: { gte: query.startTime } });
    if (query.endTime !== undefined) AND.push({ uptime: { lte: query.endTime } });

    const rows = await this.repository.listMemberSendOrders(db, where, query.page, query.limit);

    // ---- 订单面依赖（arrival/FBA/domestic sendprice 兜底）一次性取 ----
    const sids = rows.map((r) => r.sid);
    const ordersBySid = await this.ordersPort.listBriefBySids(sids);

    const projected: SendOrderMemberRow[] = [];
    for (const r of rows) {
      const orders = ordersBySid.get(r.sid) ?? [];

      // resolveDomesticSendprice：列值 >0 用列值；否则活跃订单（排除转运 type=2）sendprice 汇总
      let domestic = round2(Number(r.sendprice));
      if (domestic <= 0) {
        domestic = round2(
          orders
            .filter((o) => o.type !== 2)
            .reduce((sum, o) => sum + (round2(o.sendprice) > 0 ? round2(o.sendprice) : 0), 0),
        );
      }
      // calculateTotalfee：round2 四项 + domestic
      const totalSendFee = round2(
        round2(Number(r.freight)) + round2(Number(r.serverfee)) + round2(Number(r.customsfee)) + round2(Number(r.remotefee)) + domestic,
      );

      // resolveArrivalField：首订单 mark_flag arrival 位非 0（无订单 = 0）
      const firstOrder = orders[0];
      const arrivalFlag = firstOrder ? ((firstOrder.markFlag ?? 0) >> MARK_FLAG_ARRIVAL_POSITION) & 0b11 : 0;
      const arrival = arrivalFlag === 0 ? 0 : 1;

      // resolveFBAField：任一订单 yanhuofba === 'FBA'
      const fba = orders.some((o) => o.yanhuofba === 'FBA');

      // resolveCommentField：comment 列 JSON {comment}，空/解析失败 = ''
      let comment = '';
      if (r.comment) {
        try {
          const parsed = JSON.parse(r.comment) as { comment?: unknown };
          comment = typeof parsed?.comment === 'string' ? parsed.comment : '';
        } catch {
          comment = '';
        }
      }

      // resolveAirbillsField：空 → sn '#' 拆分合成；非空 → sn 去重
      let airbills: Airbill[];
      const rawAirbills = await this.repository.listAirbills(db, r.sid);
      if (rawAirbills.length === 0) {
        airbills = (r.sn ?? '').split('#').map((sn) => ({ sendid: r.sid, sn, traceInfo: null }));
      } else {
        const seen = new Set<string>();
        airbills = [];
        for (const a of rawAirbills) {
          if (seen.has(a.sn ?? '')) continue;
          seen.add(a.sn ?? '');
          airbills.push({ sendid: a.sendid ?? r.sid, sn: a.sn, traceInfo: a.trace_info });
        }
      }

      // resolveShippingWebsiteUrlField：deliveryname 空 = ''；端口 null → Google 搜索兜底
      let shippingWebsiteUrl = '';
      if (r.deliveryname) {
        const resolved = this.shippingWebsitePort.resolve(r.deliveryname);
        shippingWebsiteUrl = resolved ?? `https://www.google.co.jp/search?q=${encodeURIComponent(r.deliveryname)}`;
      }

      projected.push({
        sid: r.sid,
        uid: r.uid ?? 0, // 列可空但旧 GraphQL Type::int() 非 null——实际恒有值，兜底 0
        oids: r.oids,
        consignee: r.consignee,
        address: r.address,
        tel: r.tel,
        zip: r.zip,
        deliveryName: r.deliveryname,
        sn: r.sn,
        countWeight: r.countweight,
        dfSpec: r.dflwh,
        state: (r.state ?? 1) as SendOrderMemberRow['state'],
        freight: String(r.freight),
        serverFee: String(r.serverfee),
        customsFee: String(r.customsfee),
        sendPrice: String(r.sendprice),
        totalSendFee: totalSendFee.toFixed(2),
        comment,
        commentAt: r.commenttime,
        reply: r.reply,
        remark: r.remark,
        haveInvoice: (r.havefapiao ?? 0) !== 0,
        fba,
        createdAt: r.addtime ? unixToIso(r.addtime) : '',
        updatedAt: r.uptime ? unixToIso(r.uptime) : '',
        shippingWebsiteUrl,
        importerInfo: r.importer_info,
        addressInfo: {
          consignee: r.consignee,
          enname: r.enname,
          companyName: r.company_name,
          country: r.country,
          address: r.address,
          tel: r.tel,
          zip: r.zip,
        },
        arrival,
        airbills,
        dfsendname: r.dfsendname,
        dfsendaddress: r.dfsendaddress,
        dfsendtel: r.dfsendtel,
        originPackageChoice: r.origin_package_choice,
      });
    }

    return ok({ rows: projected, page: query.page, pageSize: query.limit });
  }

  async createFor1688Logistics(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    oids: number[];
    receiver: { regionName?: string; detailAddress?: string };
  }): Promise<{ sid: number }> {
    return this.repository.createFor1688Logistics(input);
  }
}
