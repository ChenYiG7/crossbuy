/**
 * OrderAmountSyncService 1:1 复现（旧 app/Services/OrderAmountSyncService.php，351 行）。
 *
 * 机制：订单金额字段（goodsprice/goodsnum/goodsprice1/bargainprice/sendprice）变更后，
 * 按 tid 分组重算归一化——组内只有一个「金额承载单」（carrier）持有非零 bargainprice/
 * sendprice，其余清零；再把组内 sid 的 bargainprice 同步回 dg_sendorder、金额同步回
 * dg_fapiao。这是**读路径金额口径的根**（Σ组内 bargainprice = 运单/发票上的值）。
 *
 * 1:1 纪律：
 * - Laravel 嵌套事务 = savepoint；Prisma 无嵌套事务 → syncByOids 接收外部 tx，
 *   自身不再开事务（取消链路整体在一个事务里，失败全回滚——语义等价）
 * - `syncing` 防重入 = 进程内模块级标志（旧静态变量同语义）
 * - DeferredSync = 进程内（旧静态 deferLevel/deferredOids 同语义）；多实例部署时
 *   deferral 语义随进程，跨进程无共享（旧系统同样如此，非新引入的分叉）
 * - Order::query() **不过滤软删**（旧模型无 SoftDeletes 全局 scope，OrderWithoutTrashed
 *   才排除）——金额同步会把软删行算进组！禁"顺手"加 deleted_at 过滤。
 */
import type { Db } from './repository';
import { money, moneyEquals, moneyOf } from './money';

/** 旧 Order::AMOUNT_FIELDS——这些字段变更才触发同步 */
const AMOUNT_FIELDS = [
  'goodsprice',
  'goodsnum',
  'goodsprice1',
  'bargainprice',
  'sendprice',
] as const;

/** 组内订单行（syncByOids 的最小列集，旧 select 1:1） */
interface AmountOrderRow {
  oid: number;
  tid: string;
  sid: string | null;
  state: number | null;
  goodsprice: number;
  goodsprice1: number | null;
  goodsnum: number | null;
  bargainprice: number | null;
  sendprice: number | null;
}

const ORDER_SELECT = {
  oid: true,
  tid: true,
  sid: true,
  state: true,
  goodsprice: true,
  goodsprice1: true,
  goodsnum: true,
  bargainprice: true,
  sendprice: true,
} as const;

/** 行是金额计算参与态（非 6/10/11） */
function isActive(state: number | null): boolean {
  return !INVALID(state);
}

function INVALID(state: number | null): boolean {
  return state === 6 || state === 10 || state === 11;
}

// ---------------------------------------------------------------------------
// 金额承载单（carrier）解析 —— 旧 Order::resolveCurrentAmountCarrierFromOrders
// ---------------------------------------------------------------------------

/**
 * 旧 Order::loadAmountCarrierCandidateOrders：候选 = 组内活跃单；
 * 若候选恰属同一个非空 tid，则扩为**该 tid 全组活跃单**（可能超出传入集合）。
 */
async function loadAmountCarrierCandidates(
  db: Db,
  rows: AmountOrderRow[],
): Promise<AmountOrderRow[]> {
  const active = rows.filter((r) => isActive(r.state)).sort((a, b) => a.oid - b.oid);
  if (active.length === 0) return [];

  const tids = [...new Set(active.map((r) => r.tid).filter((t) => t !== '' && t !== null))];
  if (tids.length === 1) {
    const group = await db.dg_order.findMany({
      where: { tid: tids[0], state: { notIn: [6, 10, 11] } },
      select: ORDER_SELECT,
      orderBy: { oid: 'asc' },
    });
    return group as AmountOrderRow[];
  }
  return active;
}

/**
 * 旧 Order::resolveCurrentAmountCarrierFromOrders：
 * ① 候选里挑「sendprice≠0 或 bargainprice≠0」的 max(oid)；
 * ② 兜底看 v2_order_detail（coupon_fee≠0 或 seller_change_amount≠0 的 max(id)）；
 * ③ 再兜底 = 候选 max(oid)。
 */
export async function resolveAmountCarrier(
  db: Db,
  rows: AmountOrderRow[],
): Promise<AmountOrderRow | null> {
  const candidates = await loadAmountCarrierCandidates(db, rows);
  if (candidates.length === 0) return null;

  const holder = candidates
    .filter((r) => !moneyEquals(r.sendprice ?? 0, 0) || !moneyEquals(r.bargainprice ?? 0, 0))
    .sort((a, b) => b.oid - a.oid)[0];
  if (holder) return holder;

  const detailHolderId = await db.v2_order_detail.findFirst({
    where: {
      id: { in: candidates.map((r) => r.oid) },
      OR: [{ coupon_fee: { not: 0 } }, { seller_change_amount: { not: 0 } }],
    },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  if (detailHolderId) {
    return (
      candidates.find((r) => r.oid === detailHolderId.id) ??
      ((await db.dg_order.findUnique({
        where: { oid: detailHolderId.id },
        select: ORDER_SELECT,
      })) as AmountOrderRow | null)
    );
  }

  return candidates.sort((a, b) => b.oid - a.oid)[0] ?? null;
}

/** 旧 `Order::getAmountCalculationGroupOrders`：有 tid → 该 tid 全组活跃单；无 tid → 只有自己 */
async function loadAmountGroupOrders(db: Db, target: AmountOrderRow): Promise<AmountOrderRow[]> {
  if (target.tid !== null && target.tid !== '') {
    return (await db.dg_order.findMany({
      where: { tid: target.tid, state: { notIn: [6, 10, 11] } },
      select: ORDER_SELECT,
      orderBy: { oid: 'asc' },
    })) as AmountOrderRow[];
  }
  return [target];
}

/**
 * 旧 `Order::migrateAmountCarrierToOrder`：把组内当前金额承载单的 sendprice/bargainprice
 * **搬到**目标单（含 `v2_order_detail` 整行搬迁后删源行）。
 *
 * 为什么必须搬：手动回传只改「一张单」时，若金额留在别的单上，改金额会改错行——
 * 旧系统靠「搬载体」把 payload 收敛到被编辑的那张单。1:1 保留「先清零源单再写目标单」的顺序。
 *
 * @param createdAt v2_order_detail 新建行的 created_at（Laravel `now()` 语义——调用方传
 *   `shanghaiWallClock(new Date())`）
 */
export async function migrateAmountCarrier(
  db: Db,
  target: AmountOrderRow,
  createdAt: Date,
): Promise<AmountOrderRow | null> {
  if (!isActive(target.state)) return null;

  const group = await loadAmountGroupOrders(db, target);
  const currentHolder = await resolveAmountCarrier(db, group);
  if (!currentHolder) return null;
  if (currentHolder.oid === target.oid) {
    return (await db.dg_order.findUnique({
      where: { oid: target.oid },
      select: ORDER_SELECT,
    })) as AmountOrderRow | null;
  }

  const carrierValues = {
    sendprice: money(currentHolder.sendprice ?? 0),
    bargainprice: money(currentHolder.bargainprice ?? 0),
  };

  await db.dg_order.updateMany({
    where: { oid: currentHolder.oid },
    data: { sendprice: 0, bargainprice: 0 },
  });
  await db.dg_order.updateMany({ where: { oid: target.oid }, data: carrierValues });

  const detail = await db.v2_order_detail.findUnique({ where: { id: currentHolder.oid } });
  if (detail) {
    const rest: Record<string, unknown> = { ...detail };
    delete rest['id'];
    delete rest['created_at'];
    delete rest['updated_at'];
    // Prisma 的 Json 空值要用 Prisma.JsonNull 表达；本文件不引 @crossbuy/db（边界纪律）⇒
    // 「读到的行原样回写」用 as never 收口（值域与读源同构，无运行期风险）
    const detailData = { ...rest, updated_at: createdAt } as never;
    const existing = await db.v2_order_detail.findUnique({
      where: { id: target.oid },
      select: { id: true },
    });
    if (existing) {
      await db.v2_order_detail.update({ where: { id: target.oid }, data: detailData });
    } else {
      await db.v2_order_detail.create({
        data: {
          ...(detailData as object),
          id: target.oid,
          created_at: createdAt,
          updated_at: createdAt,
        } as never,
      });
    }
    await db.v2_order_detail.delete({ where: { id: currentHolder.oid } });
  }

  return (await db.dg_order.findUnique({
    where: { oid: target.oid },
    select: ORDER_SELECT,
  })) as AmountOrderRow | null;
}

// ---------------------------------------------------------------------------
// 组内归一化（normalize*）
// ---------------------------------------------------------------------------
/** 旧 calculateBargainpriceFromOrders：Σ max(0, (goodsprice − 有效goodsprice1) × goodsnum) */
function calculateBargainpriceFromOrders(rows: AmountOrderRow[]): number {
  let total = 0;
  for (const r of rows) {
    const goodsprice = moneyOf(r.goodsprice);
    const goodsprice1 = moneyOf(r.goodsprice1 ?? 0);
    const goodsnum = r.goodsnum ?? 0;
    if (goodsnum <= 0) continue;
    const effective1 = goodsprice1 > 0 ? goodsprice1 : goodsprice;
    total += Math.max(0, money(goodsprice - effective1) * goodsnum);
  }
  return money(total);
}

/** 旧 syncGoodsprice1ByBargainprice：显式 bargainprice 意图时按行占比反摊 goodsprice1 */
async function syncGoodsprice1ByBargainprice(
  db: Db,
  rows: AmountOrderRow[],
  totalBargainprice: number,
): Promise<void> {
  const sum = money(rows.reduce((acc, r) => acc + r.goodsprice * (r.goodsnum ?? 0), 0));
  if (sum <= 0) return;

  for (const r of rows) {
    const goodsnum = r.goodsnum ?? 0;
    const goodsprice = money(r.goodsprice);
    if (goodsnum <= 0) continue;

    const subSum = money(goodsprice * goodsnum);
    const lineBargain = (subSum / sum) * totalBargainprice;
    const lineUnitReduce = lineBargain / goodsnum;
    const newGoodsprice1 = money(goodsprice - lineUnitReduce);
    const oldGoodsprice1 = money(r.goodsprice1 ?? 0);

    if (!moneyEquals(newGoodsprice1, oldGoodsprice1)) {
      await db.dg_order.updateMany({
        where: { oid: r.oid },
        data: { goodsprice1: newGoodsprice1 },
      });
    }
  }
}

/** 旧 normalizeOrderSendprice：carrier 持有组内 sendprice 总额，其余清零 */
async function normalizeOrderSendprice(
  db: Db,
  rows: AmountOrderRow[],
  active: AmountOrderRow[],
  carrier: AmountOrderRow | null,
): Promise<void> {
  const totalSendprice = money(active.reduce((acc, r) => acc + (r.sendprice ?? 0), 0));
  for (const r of rows) {
    const expected = carrier && r.oid === carrier.oid ? totalSendprice : 0;
    if (!moneyEquals(r.sendprice ?? 0, expected)) {
      await db.dg_order.updateMany({ where: { oid: r.oid }, data: { sendprice: expected } });
    }
  }
}

/** 旧 normalizeOrderBargainprice：carrier 持有 totalBargainprice，其余清零；显式 bargainprice 意图时跳过 carrier 行 */
async function normalizeOrderBargainprice(
  db: Db,
  rows: AmountOrderRow[],
  /** 旧签名第 2 参 $activeOrders：函数体未使用，保真保留位 */
  _active: AmountOrderRow[],
  totalBargainprice: number,
  carrier: AmountOrderRow | null,
  hasExplicitBargainpriceIntent: boolean,
): Promise<void> {
  const capped = money(Math.max(0, totalBargainprice));
  for (const r of rows) {
    const expected = carrier && r.oid === carrier.oid ? capped : 0;
    if (hasExplicitBargainpriceIntent && carrier && r.oid === carrier.oid) continue;
    if (!moneyEquals(r.bargainprice ?? 0, expected)) {
      await db.dg_order.updateMany({ where: { oid: r.oid }, data: { bargainprice: expected } });
    }
  }
}

// ---------------------------------------------------------------------------
// 下游同步（运单 / 发票）
// ---------------------------------------------------------------------------

/** 旧 syncSendOrders：组内 sid 非空者 → dg_sendorder.bargainprice = Σ(该 sid 下活跃单 bargainprice) */
async function syncSendOrders(db: Db, rows: AmountOrderRow[]): Promise<void> {
  const sids = [
    ...new Set(rows.map((r) => r.sid).filter((s): s is string => s !== null && s !== '')),
  ];
  for (const sid of sids) {
    // dg_sendorder.sid 是 Int 主键（dg_order.sid 是字符串列）——旧 Laravel find('123') 同样隐式转 int
    const sendOrder = await db.dg_sendorder.findUnique({
      where: { sid: Number(sid) },
      select: { sid: true, bargainprice: true },
    });
    if (!sendOrder) continue;

    const bargainprice = money(
      Number(
        (
          await db.dg_order.aggregate({
            where: { sid, state: { notIn: [6, 10, 11] } },
            _sum: { bargainprice: true },
          })
        )._sum.bargainprice ?? 0,
      ),
    );

    if (!moneyEquals(Number(sendOrder.bargainprice ?? 0), bargainprice)) {
      await db.dg_sendorder.updateMany({ where: { sid: Number(sid) }, data: { bargainprice } });
    }
  }
}

/** 旧 syncFapiao：dg_fapiao（sid+oid 定位）同步 goodsprice（=goodsprice1>0?1:0）/goodstotal/bargainprice/sendprice */
async function syncFapiao(db: Db, rows: AmountOrderRow[]): Promise<void> {
  for (const r of rows) {
    const sid = r.sid;
    if (sid === null || sid === '') continue;

    const goodsprice = money(r.goodsprice);
    const goodsprice1 = money(r.goodsprice1 ?? 0);
    const goodsnum = r.goodsnum ?? 0;
    const sendprice = money(r.sendprice ?? 0);
    const bargainprice = money(r.bargainprice ?? 0);

    const fapiaoGoodsprice = goodsprice1 > 0 ? goodsprice1 : goodsprice;
    const goodstotal = money(fapiaoGoodsprice * goodsnum);

    await db.dg_fapiao.updateMany({
      where: { sid: Number(sid), oid: r.oid },
      data: { goodsprice: fapiaoGoodsprice, goodstotal, bargainprice, sendprice },
    });
  }
}

// ---------------------------------------------------------------------------
// syncByOids + Deferred
// ---------------------------------------------------------------------------

let syncing = false;

/** 旧 OrderAmountSyncService::syncByOids（重入保护 + 组循环归一化 + 下游同步） */
export async function syncOrderAmountsByOids(
  db: Db,
  rawOids: number[],
  changedFields: string[] = [],
): Promise<void> {
  const oids = [...new Set(rawOids.map((o) => Math.trunc(o)).filter((o) => o > 0))];
  if (oids.length === 0 || syncing) return;
  if (
    changedFields.length > 0 &&
    !changedFields.some((f) => (AMOUNT_FIELDS as readonly string[]).includes(f))
  )
    return;

  syncing = true;
  try {
    const affected = (await db.dg_order.findMany({
      where: { oid: { in: oids } },
      select: { oid: true, tid: true },
    })) as Array<{ oid: number; tid: string }>;

    // buildOrderGroups：无 tid → 单 oid 组；有 tid → 该 tid 全组 oid（禁顺手去重语义变更）
    const groups: number[][] = [];
    for (const row of affected) {
      if (row.tid === '' || row.tid === null) {
        groups.push([row.oid]);
      } else {
        const groupOids = (
          await db.dg_order.findMany({
            where: { tid: row.tid },
            select: { oid: true },
            orderBy: { oid: 'asc' },
          })
        ).map((g) => g.oid);
        groups.push(groupOids);
      }
    }

    for (const groupOids of groups) {
      const orders = (await db.dg_order.findMany({
        where: { oid: { in: groupOids } },
        select: ORDER_SELECT,
        orderBy: { oid: 'asc' },
      })) as AmountOrderRow[];
      if (orders.length === 0) continue;

      const active = orders.filter((r) => isActive(r.state));
      const hasExplicitBargainpriceIntent = changedFields.includes('bargainprice');
      const triggeredByBargainprice =
        hasExplicitBargainpriceIntent &&
        !changedFields.includes('goodsprice') &&
        !changedFields.includes('goodsnum') &&
        !changedFields.includes('goodsprice1');

      let totalBargainprice: number;
      if (triggeredByBargainprice) {
        totalBargainprice = money(active.reduce((acc, r) => acc + (r.bargainprice ?? 0), 0));
        await syncGoodsprice1ByBargainprice(db, active, totalBargainprice);
      } else {
        totalBargainprice = calculateBargainpriceFromOrders(active);
      }

      const carrier = await resolveAmountCarrier(db, orders);

      await normalizeOrderSendprice(db, orders, active, carrier);
      await normalizeOrderBargainprice(
        db,
        orders,
        active,
        totalBargainprice,
        carrier,
        hasExplicitBargainpriceIntent,
      );

      const refreshed = (await db.dg_order.findMany({
        where: { oid: { in: groupOids } },
        select: ORDER_SELECT,
        orderBy: { oid: 'asc' },
      })) as AmountOrderRow[];

      await syncSendOrders(db, refreshed);
      await syncFapiao(db, refreshed);
    }
  } finally {
    syncing = false;
  }
}

/**
 * 旧静态 deferral（beginDeferredSync/flushDeferredSync/discardDeferredSync/dispatchSync）。
 * 仅取消链路（cancelOrders）使用：事务里改金额 → flush 时统一同步。
 */
export class DeferredAmountSync {
  private deferLevel = 0;
  private pendingOids = new Set<number>();
  private pendingFields = new Set<string>();

  begin(): void {
    this.deferLevel++;
  }

  /** 旧 flushDeferredSync：等级归零时一次性同步（注意：同步在**事务内**执行，失败即整体回滚） */
  async flush(db: Db): Promise<void> {
    if (this.deferLevel > 0) this.deferLevel--;
    if (this.deferLevel > 0 || this.pendingOids.size === 0) return;

    const oids = [...this.pendingOids];
    const fields = [...this.pendingFields];
    this.pendingOids = new Set();
    this.pendingFields = new Set();
    await syncOrderAmountsByOids(db, oids, fields);
  }

  /** 旧 discardDeferredSync：异常路径丢弃挂起项 */
  discard(): void {
    if (this.deferLevel > 0) this.deferLevel--;
    if (this.deferLevel === 0) {
      this.pendingOids = new Set();
      this.pendingFields = new Set();
    }
  }

  /** 旧 dispatchSync：defer 期间只收集；非 defer 期直接同步（db 由调用方给——域内禁自带连接） */
  async dispatch(db: Db, rawOids: number[], changedFields: string[] = []): Promise<void> {
    const oids = [...new Set(rawOids.map((o) => Math.trunc(o)).filter((o) => o > 0))];
    if (oids.length === 0 || syncing) return;
    if (
      changedFields.length > 0 &&
      !changedFields.some((f) => (AMOUNT_FIELDS as readonly string[]).includes(f))
    )
      return;

    if (this.deferLevel > 0) {
      for (const oid of oids) this.pendingOids.add(oid);
      for (const f of changedFields) this.pendingFields.add(f);
      return;
    }
    await syncOrderAmountsByOids(db, oids, changedFields);
  }
}
