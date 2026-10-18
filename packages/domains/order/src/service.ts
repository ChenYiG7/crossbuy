import type { Principal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import { OrderStatus, type MemberOrderRow, type OrderListQuery } from '@crossbuy/contract';

import type { OrderError } from './errors';
import { orderError } from './errors';
import { moneyEquals, moneyOf } from './money';
import { DF_CONFIGS, ORDER_FLAGS, ORDER_TYPE, RECORD, UTYPE } from './legacy-constants';
import { DeferredAmountSync } from './amount-sync';
import type { LegacyWhere, ListOrderRow, OrderRepository, Tx } from './repository';
import { unixToIso } from '@crossbuy/utils';
import {
  parseSkuName,
  splitItemLocation,
  bargainDisplayOf,
  bargainDisplayFromSec,
  readExtendField,
  MADE_IN_CHINA_YES,
  MADE_IN_CHINA_NO,
  MARK_FLAG_FAVORITE_POSITION,
  MARK_FLAG_ARRIVAL_POSITION,
} from './list-helpers';

/**
 * order 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：Services/Order + Services/Member/*MemberOrder*；R3 归属：oms
 */
export interface OrderService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'order';

  /**
   * 用户取消订单（旧 OrderCancelService::cancelOrders + CancelMemberOrderService 归一化 1:1）。
   * 行锁（user → orders）→ 守卫（1/6 态 + 归属）→ sendprice 组内转移 → 返金入账 →
   * state=10 + bargainprice=0 → 组金额同步（deferred flush，同事务）。
   */
  cancelOrders(
    principal: Principal,
    rawOids: Array<number | string>,
  ): Promise<Result<number[], OrderError>>;

  /**
   * 会员订单列表（旧 listOrderV2 + OrderListInput::buildQuery 1:1）。
   * 状态显示合并（3 并 12）/ dfflag type 分流 / keyword 三词上限在此落；
   * displayFrom = 「安くなった額」展示窗口起点（旧 config('bargain.display_from')，注入）。
   */
  listOrders(
    principal: Principal,
    query: OrderListQuery,
  ): Promise<
    Result<{ rows: MemberOrderRow[]; total: number; page: number; pageSize: number }, OrderError>
  >;
}

/** 旧 lang('order_id')（custom-trans.php:157） */
const LANG_ORDER_ID = 'オーダーID:';

/** 旧 calculateRefundAmount 的 DG 服务费率（goodsTotal * 0.05） */
const DG_SERVICE_FEE_RATE = 0.05;

/** Asia/Shanghai 当天零点秒（旧 strtotime('today')，生产 PHP 时区 Asia/Shanghai） */
function todayStartSec(now: Date = new Date()): number {
  const jst = new Date(now.getTime() + 8 * 3600 * 1000);
  const utcMidnight = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return Math.floor(utcMidnight / 1000) - 8 * 3600;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 旧 CancelMemberOrderService::normalizeOrderIds：int 化 → 正数过滤 → 去重 */
function normalizeOids(raw: Array<number | string>): number[] {
  return [
    ...new Set(raw.map((v) => Math.trunc(Number(v))).filter((n) => Number.isFinite(n) && n > 0)),
  ];
}

/** 取消链路的订单行（lockOrdersForCancel 列集） */
type CancelOrderRow = Awaited<ReturnType<OrderRepository['lockOrdersForCancel']>>[number];
/** 取消链路的用户行（lockUser 列集） */
type CancelUserRow = NonNullable<Awaited<ReturnType<OrderRepository['lockUser']>>>;

export class OrderServiceImpl implements OrderService {
  readonly domain = 'order' as const;

  private readonly deferredSync = new DeferredAmountSync();

  constructor(
    protected readonly repository: OrderRepository,
    /** 注入便于测试替换时钟（默认真实时间） */
    protected readonly clock: () => Date = () => new Date(),
    /**
     * 事务运行器（必传：组合根给 $transaction，测试注入外层 rollback 事务的 tx——
     * 域内禁自带连接，dispatch 同理）。
     */
    protected readonly runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
    /** 「安くなった額」展示窗口起点秒（旧 config('bargain.display_from','2026-11-01') Asia/Tokyo 零点；注入防隐式时区） */
    protected readonly displayFromSec: number = bargainDisplayFromSec('2026-11-01'),
  ) {}

  async cancelOrders(
    principal: Principal,
    rawOids: Array<number | string>,
  ): Promise<Result<number[], OrderError>> {
    if (principal.kind !== 'member') {
      return err(orderError('NO_PERMISSIONS'));
    }
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err(orderError('NO_PERMISSIONS'));
    }

    const oids = normalizeOids(rawOids);
    if (oids.length === 0) {
      return err(orderError('ORDER_NOT_FOUND'));
    }

    try {
      const canceled = await this.runTx(async (tx) => {
        this.deferredSync.begin();
        try {
          // ① 行锁用户（旧 lockForUpdate；不存在 = no_permissions）
          const user = await this.repository.lockUser(tx, uid);
          if (!user) throw orderError('NO_PERMISSIONS');

          // ② 行锁订单（OrderWithoutTrashed：排除软删；数量不符 = not_found）
          const orders = await this.repository.lockOrdersForCancel(tx, oids);
          if (oids.length !== orders.length) throw orderError('ORDER_NOT_FOUND');
          const byOid = new Map(orders.map((o) => [o.oid, o]));

          // ③ 逐单取消
          for (const oid of oids) {
            await this.cancelSingleOrder(tx, user, byOid.get(oid));
          }

          // ④ 组金额归一化 + 运单/发票同步（旧 flushDeferredSync，事务内）
          await this.deferredSync.flush(tx);
          return oids;
        } catch (e) {
          this.deferredSync.discard();
          throw e;
        }
      });
      return ok(canceled);
    } catch (e) {
      // 旧 UserError → GraphQL 异常；新系统 Result 化（zod 契约外的错误对象原样透传）
      if (isOrderError(e)) return err(e);
      throw e;
    }
  }

  /** 旧 cancelSingleOrder（守卫 → sendprice 转移 → 返金 → 状态收尾） */
  async listOrders(
    principal: Principal,
    query: OrderListQuery,
  ): Promise<
    Result<{ rows: MemberOrderRow[]; total: number; page: number; pageSize: number }, OrderError>
  > {
    if (principal.kind !== 'member') {
      return err({ code: 'NO_PERMISSIONS', message: '非会员主体' });
    }
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'NO_PERMISSIONS', message: 'Principal 非法' });
    }

    const db = this.repository.db;

    // ---- dfflag 分流（旧 buildQuery：代发强制 type=3，普通强制 type in [1,2]）----
    const isDf = await this.repository.getUserDfFlag(db, uid);
    const typeFilter: LegacyWhere['type'] = isDf
      ? { equals: ORDER_TYPE.DAIFA }
      : { in: [ORDER_TYPE.DAIGOU, ORDER_TYPE.ZHUANYUN] };

    const AND: NonNullable<LegacyWhere['AND']> = [];
    const where: LegacyWhere = { uid, type: typeFilter, AND };

    // ---- 状态过滤：3 并 12（不良待确认对客户显示为在途，旧 resolveStateField 对偶逻辑在过滤面）----
    let states: number[] = [];
    if (query.states) {
      states = query.states
        .split(',')
        .map((v) => Number(v.trim()))
        .filter(Number.isInteger);
      if (
        states.includes(OrderStatus.SEND) &&
        !states.includes(OrderStatus.AFTER_SALE_WAIT_CHECK)
      ) {
        states.push(OrderStatus.AFTER_SALE_WAIT_CHECK);
      }
      AND.push({ state: { in: states } });
    } else if (query.state !== undefined) {
      if (query.state === OrderStatus.SEND) {
        AND.push({ state: { in: [OrderStatus.SEND, OrderStatus.AFTER_SALE_WAIT_CHECK] } });
      } else {
        AND.push({ state: query.state });
      }
    }

    // ---- queryType 特殊视图 ----
    if (query.queryType === 'refuse') {
      // 禁运品：state < 5 且 item_location 非空且非 MADE_IN_CHINA 标记（旧 :144-149）
      AND.push({
        state: { lt: OrderStatus.DELIVERY },
        item_location: { notIn: ['', MADE_IN_CHINA_YES, MADE_IN_CHINA_NO] },
      });
    } else if (query.queryType === 'question') {
      const oids = await this.repository.listOidsByUnreadChat(db, uid);
      AND.push({ oid: { in: oids } }); // 空集 = Prisma in [] 恒 false，与旧 whereIn([]) 同义
    }

    // ---- 单列过滤（顺序 1:1 buildQuery）----
    if (query.expressNo) AND.push({ expressno: query.expressNo });
    if (query.fnsku) AND.push({ FNSKU: query.fnsku });

    // ---- keyword：三词上限 + `数字/数字` oid 精确路径 + 六列 like + detail 日文名 ----
    if (query.keyword) {
      const keywords = query.keyword.split(' ').filter((v) => v !== '');
      if (keywords.length > 3) {
        return err({ code: 'ORDER_KEYWORD_TOO_MANY', message: '搜索关键词最多只能输入3个关键词' });
      }
      const ors: NonNullable<LegacyWhere['OR']> = [];
      if (/^[0-9]+(\/[0-9]*)+$/.test(query.keyword)) {
        const ids = query.keyword.split('/').map(Number).filter(Number.isInteger);
        ors.push({ oid: { in: ids } });
      } else {
        for (const value of keywords) {
          const kw = { contains: value };
          ors.push(
            { goodsname: kw },
            { goodsseller: kw },
            { outid: kw },
            { FNSKU: kw },
            { goodsremark: kw },
            { yanhuoasin: kw },
          );
          if (Number.isInteger(Number(value))) ors.push({ oid: { equals: Number(value) } });
        }
        // 旧 whereHas('detail', goods_name_trans like)——两步查集合并入 OR
        for (const value of keywords) {
          const detailOids = await this.repository.listOidsByDetailNameLike(db, value);
          if (detailOids.length > 0) ors.push({ oid: { in: detailOids } });
        }
      }
      AND.push({ OR: ors });
    }

    if (query.startTime) AND.push({ addtime: { gte: query.startTime } });
    if (query.endTime) AND.push({ addtime: { lte: query.endTime } });

    // ---- 代发专属：在库保管 / 电商 SKU 关联（旧 :171-196）----
    if (isDf) {
      if (query.storeMode) {
        if (query.storeState) {
          if (query.storeState === 1) {
            AND.push({ goodsnum: { gt: 0 }, state: { not: OrderStatus.DELIVERY } });
          } else {
            AND.push({ OR: [{ goodsnum: { lte: 0 } }, { state: OrderStatus.DELIVERY }] });
          }
        }
        AND.push({ dfstoremode: 1 });
      }
      if (query.inEcommerceSkuIds) {
        const skuIds = query.inEcommerceSkuIds.split(',').map(Number).filter(Number.isInteger);
        const oids = await this.repository.listOidsByEcommerceSkuIds(db, skuIds);
        AND.push({ oid: { in: oids } });
      } else if (query.notInEcommerceSkuIds) {
        const skuIds = query.notInEcommerceSkuIds.split(',').map(Number).filter(Number.isInteger);
        const bound = await this.repository.listOidsByEcommerceSkuIds(db, skuIds);
        AND.push({ oid: { notIn: bound } });
      }
    }

    if (query.splitId) {
      const spuIds = await this.repository.listSpuIdsBySplitOid(db, query.splitId);
      AND.push({ oid: { in: spuIds } });
    }
    if (query.sid) AND.push({ sid: String(query.sid) });
    if (query.outId) AND.push({ outid: query.outId });

    // ---- mark_flag 位过滤（Prisma 无位运算 → raw 预筛 oid 集）----
    if (query.markFavorite !== undefined) {
      const oids = await this.repository.listOidsByMarkFlag(
        db,
        uid,
        MARK_FLAG_FAVORITE_POSITION,
        query.markFavorite,
      );
      AND.push({ oid: { in: oids } });
    }
    if (query.markArrival !== undefined) {
      const oids = await this.repository.listOidsByMarkFlag(
        db,
        uid,
        MARK_FLAG_ARRIVAL_POSITION,
        query.markArrival,
      );
      AND.push({ oid: { in: oids } });
    }

    if (query.sellerId) AND.push({ supplier_shop_id: query.sellerId });
    if (query.productId) AND.push({ supplier_product_id: query.productId });
    if (query.updatedAfter) AND.push({ uptime: { gte: query.updatedAfter } });

    const { rows, total } = await this.repository.listMemberOrders(
      db,
      where,
      query.page,
      query.limit,
    );

    // ---- detail 投影（goodsNameTrans / goodSkuTrans）----
    const details = await this.repository.findOrderDetails(
      db,
      rows.map((r) => r.oid),
    );

    const projected = rows.map((r) => this.projectListRow(r, details.get(r.oid)));
    return ok({ rows: projected, total, page: query.page, pageSize: query.limit });
  }

  /** 行投影（旧 Member/OrderType resolve* 系列 1:1） */
  protected projectListRow(
    r: ListOrderRow,
    detail:
      | { goods_name_trans: string | null; sku_trans: unknown; instant_chat_tag: string | null }
      | undefined,
  ): MemberOrderRow {
    const goodsNum = r.goodsnum ?? 0;
    const skuDetail = parseSkuName(r.sku_name, r.goodssize, r.goodscolor);
    const skuTrans = Array.isArray(detail?.sku_trans)
      ? (detail?.sku_trans as Array<{ name: string; value: string }>)
      : skuDetail;
    const bargain = bargainDisplayOf(
      r.addtime ?? 0,
      r.state ?? 0,
      r.goodsprice,
      Number(r.goodsprice1 ?? 0),
      goodsNum,
      this.displayFromSec,
    );
    const madeInChina = splitItemLocation(r.item_location).madeInChina;
    const markFlag = r.mark_flag ?? 0;

    return {
      oid: r.oid,
      sid: r.sid,
      type: (r.type ?? 0) as MemberOrderRow['type'],
      // 显示态：12 → 3（旧 resolveStateField）
      state: (r.state === OrderStatus.AFTER_SALE_WAIT_CHECK
        ? OrderStatus.SEND
        : (r.state ?? 0)) as MemberOrderRow['state'],
      expressNo: r.expressno,
      goodsId: r.goodsid,
      goodsName: r.goodsname,
      goodsNameTrans: detail?.goods_name_trans ?? r.goodsname,
      goodsUrl: r.goodsurl,
      goodsImg: r.goodsimg,
      goodsSize: r.goodssize,
      goodsColor: r.goodscolor,
      goodsSeller: r.goodsseller,
      goodsSite: r.goodssite,
      goodSkus: skuDetail,
      goodSkuTrans: skuTrans,
      skuId: null, // 旧 Type 引 skuId 列但 Member 面未消费实际值（字段声明无 alias、resolve 缺省）——保持 null 并登记
      ship: r.ship,
      goodsPrice: moneyOf(r.goodsprice).toString(),
      goodsPrice1: moneyOf(Number(r.goodsprice1 ?? 0)).toString(),
      bargainStatus: bargain.status,
      bargainAmount: bargain.amount,
      goodsNum,
      itemLocation: splitItemLocation(r.item_location).reason,
      madeInChina,
      sendPrice: moneyOf(r.sendprice).toString(),
      goodsRemark: r.goodsremark,
      orderRemark: r.orderremark,
      fba: r.yanhuofba === '' ? null : r.yanhuofba,
      asin: r.yanhuoasin === '' ? null : r.yanhuoasin,
      fnsku: r.FNSKU === '' ? null : r.FNSKU,
      outId: r.outid,
      tid: r.tid === '' ? null : r.tid,
      createdAt: r.addtime ? unixToIso(r.addtime) : '',
      arrivedAt: r.arrivetime ? unixToIso(r.arrivetime) : null,
      dfStoreMode: r.dfstoremode ?? 0,
      markFavorite: (markFlag >> MARK_FLAG_FAVORITE_POSITION) & 0b11,
      markArrival: (markFlag >> MARK_FLAG_ARRIVAL_POSITION) & 0b11,
      platformOrderNo: readExtendField(r.extend, 'platform_order_no'),
    };
  }

  protected async cancelSingleOrder(
    tx: Tx,
    user: CancelUserRow,
    order: CancelOrderRow | undefined,
  ): Promise<void> {
    // 守卫第一分支：空单 = not_found（旧 ensureCancelable 首判；TS 收窄在此显式化）
    if (!order) throw orderError('ORDER_NOT_FOUND');
    this.ensureCancelable(user, order);

    await this.transferSendpriceToActiveOrder(tx, order);

    const refundAmount = this.calculateRefundAmount(user, order);
    if (refundAmount > 0) {
      const isDaifa = order.type === ORDER_TYPE.DAIFA;
      const ts = nowSec();
      await this.repository.addBalanceRecord(tx, {
        uid: user.uid,
        uname: user.uname,
        amount: refundAmount,
        action: RECORD.ACTION_4,
        remark: this.buildRefundNote(order),
        sn: '',
        oid: isDaifa ? 0 : order.oid,
        ordflag: isDaifa ? ORDER_FLAGS.DF : ORDER_FLAGS.DG,
        extendJson: JSON.stringify(this.buildRefundExtend(order)),
        nowSec: ts,
        balanceBefore: moneyOf(user.money),
        dfflag: user.dfflag,
      });
    }

    // 金额字段与状态合并为一次更新（旧注释原话：避免多轮无意义同步/事件链）
    await this.repository.finalizeCancel(tx, order.oid, nowSec());

    // 旧模型事件：金额字段变更触发 dispatchSync（defer 期间只收集）
    await this.deferredSync.dispatch(tx, [order.oid], ['bargainprice', 'state']);
  }

  /** 旧 ensureCancelable（守卫顺序 1:1：空 → 归属 → 状态） */
  protected ensureCancelable(user: CancelUserRow, order: CancelOrderRow | undefined): void {
    if (!order) throw orderError('ORDER_NOT_FOUND');
    if (order.uid !== user.uid) throw orderError('NO_PERMISSIONS');
    if (order.state !== 1 && order.state !== 6) throw orderError('ORDER_NOT_ALLOWED_CANCEL');
  }

  /** 旧 transferSendpriceToActiveOrder：sendprice≠0 时组内转移到活跃接收单（除自身外 max oid） */
  protected async transferSendpriceToActiveOrder(tx: Tx, order: CancelOrderRow): Promise<void> {
    if (moneyEquals(order.sendprice ?? 0, 0)) return;

    // 旧 getAmountCalculationGroupOrders：tid 非空 → 全组（排除无效态）；否则仅自身
    let groupOrders: Array<{ oid: number; sendprice: number | null; state: number | null }>;
    if (order.tid !== '' && order.tid !== null) {
      groupOrders = await this.repository.findActiveGroupOrdersByTid(tx, order.tid);
    } else {
      groupOrders = [order];
    }
    // 旧 filterOrdersForAmountCalculation（再过滤一遍；getAmountCalculationGroupOrders 已滤，幂等）
    const activeOrders = groupOrders.filter(
      (o) => o.state !== 6 && o.state !== 10 && o.state !== 11,
    );
    const receiver = activeOrders
      .filter((o) => o.oid !== order.oid)
      .sort((a, b) => b.oid - a.oid)[0];
    if (!receiver) return;

    const totalSendprice = moneyOf(activeOrders.reduce((acc, o) => acc + (o.sendprice ?? 0), 0));
    const groupOrderIds = groupOrders.map((o) => o.oid);
    const currentReceiver = moneyOf(receiver.sendprice ?? 0);

    await this.repository.clearSendprice(tx, groupOrderIds);
    if (!moneyEquals(currentReceiver, totalSendprice)) {
      await this.repository.setSendprice(tx, receiver.oid, totalSendprice);
    }
  }

  /** 旧 calculateRefundAmount（DG/DF/ZY 三分支 + userCharged 优先） */
  protected calculateRefundAmount(user: CancelUserRow, order: CancelOrderRow): number {
    const today = todayStartSec(this.clock());
    const userCharged = user.validity >= today && user.utype === UTYPE.CHARGED;

    if ((order.inspection ?? 0) > 0) {
      // 旧 logMessage("无效订单返金#{oid}：订单 inspection 值大于0") —— 结构化日志（R2 接 logger）
      console.error(`无效订单返金#${order.oid}：订单 inspection 值大于0`, { order: order.oid });
    }

    switch (order.type) {
      case ORDER_TYPE.DAIGOU:
        return this.calculateDgRefundAmount(order, userCharged);
      case ORDER_TYPE.DAIFA:
        return this.calculateDfRefundAmount(user, order, userCharged);
      case ORDER_TYPE.ZHUANYUN:
        return 0;
      default:
        throw orderError('ORDER_INVALID_TYPE');
    }
  }

  /** 旧 calculateDgRefundAmount（服务费 ceil 到分，抵减 extend.deducted_service_fee） */
  protected calculateDgRefundAmount(order: CancelOrderRow, userCharged: boolean): number {
    const goodsTotal = (order.goodsprice + (order.inspection ?? 0)) * (order.goodsnum ?? 0);
    if (userCharged) return goodsTotal;

    const serviceCharge = Math.ceil(goodsTotal * DG_SERVICE_FEE_RATE * 100) / 100;
    const actualServiceCharge = Math.max(
      0,
      Math.round((serviceCharge - this.getDeductedServiceFee(order)) * 100) / 100,
    );
    return round2(goodsTotal + actualServiceCharge);
  }

  /** 旧 calculateDfRefundAmount（charged 全额 / AMTLIMIT 系数 / 基础价 + dffee） */
  protected calculateDfRefundAmount(
    user: CancelUserRow,
    order: CancelOrderRow,
    userCharged: boolean,
  ): number {
    if (userCharged) {
      return (order.goodsprice + (order.inspection ?? 0)) * (order.goodsnum ?? 0);
    }
    if (DF_CONFIGS.ISAMTLIMIT === 1 && order.goodsprice > DF_CONFIGS.AMTLIMIT) {
      return (
        (order.goodsprice + (order.inspection ?? 0)) *
        (order.goodsnum ?? 0) *
        DF_CONFIGS.AMTLIMITFEE
      );
    }
    return (
      (order.goodsprice + (order.inspection ?? 0) + moneyOf(user.dffee ?? 0)) *
      (order.goodsnum ?? 0)
    );
  }

  /** 旧 buildRefundNote（HTML 备注串 1:1——含转义反斜杠，dg_record.remark 原样存） */
  protected buildRefundNote(order: CancelOrderRow): string {
    const goodsLink = `<a href=\\'${order.goodsurl}\\' target=\\'_blank\\'>《${order.goodsname}》</a>`;
    const suffix = `${LANG_ORDER_ID}${order.oid} num:${order.goodsnum ?? 0}, price:${order.goodsprice} `;

    if (order.type === ORDER_TYPE.DAIFA) {
      return `<span lang="JA">直送 </span> ${goodsLink}${suffix}`;
    }
    return `${goodsLink}${suffix}`;
  }

  /**
   * 旧 buildRefundExtend：`json_decode($extend, true)` 后 is_array 判定。
   * PHP 关联数组 = JS 对象、PHP 列表 = JS 数组——两者都「truthy 保留」。
   * 往返（json_encode 回写）原样，禁结构变换。
   */
  protected buildRefundExtend(order: CancelOrderRow): unknown {
    if (!order.extend) return [];
    try {
      const parsed: unknown = JSON.parse(order.extend);
      return parsed !== null && typeof parsed === 'object' ? parsed : [];
    } catch {
      return [];
    }
  }

  /** 旧 getDeductedServiceFee：extend（关联数组形态）['deducted_service_fee'] */
  protected getDeductedServiceFee(order: CancelOrderRow): number {
    const extend = this.buildRefundExtend(order);
    const obj = extend as Record<string, unknown> | unknown[];
    const value = Array.isArray(obj) ? undefined : obj?.['deducted_service_fee'];
    return typeof value === 'number' ? value : 0;
  }
}

/** PHP round(x, 2) 半舍入远离零（正数域等价 JS toFixed 修切） */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 旧 extend 建构（ deduct 读取容错） */
function isOrderError(e: unknown): e is OrderError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}
