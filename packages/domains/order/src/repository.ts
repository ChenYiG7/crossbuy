import { LegacyPrismaRuntime, legacyPrisma, type LegacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';

/**
 * order 域 repository 防腐层（docs/04 §5 / docs/07）。
 *
 * 本文件是 order 域唯一允许 import @crossbuy/db 的位置——ESLint 边界规则强制，
 * 全仓其他位置 import 即 lint error（守卫有效性由 scripts/boundary-probe.mjs 破坏验证）。
 *
 * 事务模式：service 开 Prisma 交互式事务，把 tx 传给本类方法（旧 Laravel
 * DB::transaction + lockForUpdate 行锁语义 → Prisma $transaction 内 SELECT ... FOR UPDATE）。
 *
 * 纪律：
 * - 旧表原样读写；复现怪癖必须 1:1 并登记 docs/plans/08
 * - ⚠ `dg_order` 读取分两种：**含软删**（金额同步，旧 Order 模型无全局 scope）
 *   与**排除软删**（取消守卫，旧 OrderWithoutTrashed）——调用方显式选，禁统一化
 */
/** 事务句柄（service/amount-sync 走 repository 的类型出口，域内禁直 import @crossbuy/db） */
export type Tx = LegacyPrisma.TransactionClient;
/** db 句柄类型：client 单例或事务内 client */
export type Db = LegacyPrismaClient | Tx;

export class OrderRepository {
  // db 对域内 service/amount-sync 开放（组装 where 与分页查询共用连接）；域外仍禁直触
  constructor(public readonly db: LegacyPrismaClient = legacyPrisma) {}

  // -----------------------------------------------------------------------
  // 取消链路（OrderCancelService）
  // -----------------------------------------------------------------------

  /**
   * 行锁读用户（旧 `User::where(uid)->lockForUpdate()->first()`）。
   * 返回取消计算所需的用户列；不存在 = null（service 判 no_permissions）。
   */
  async lockUser(tx: LegacyPrisma.TransactionClient, uid: number) {
    const rows = await tx.$queryRaw<
      Array<{
        uid: number;
        uname: string;
        money: number;
        dfflag: number | null;
        utype: number | null;
        validity: number;
        dffee: number | null;
      }>
    >`SELECT uid, uname, money, dfflag, utype, validity, dffee FROM dg_users WHERE uid = ${uid} FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * 行锁读订单（旧 `OrderWithoutTrashed::whereIn(oid)->lockForUpdate()->get()`）——
   * **排除软删**。取消链路需要的列集。
   */
  async lockOrdersForCancel(tx: LegacyPrisma.TransactionClient, oids: number[]) {
    return tx.$queryRaw<
      Array<{
        oid: number;
        uid: number;
        tid: string;
        sid: string | null;
        type: number | null;
        state: number | null;
        goodsprice: number;
        goodsprice1: number | null;
        goodsnum: number | null;
        bargainprice: number | null;
        sendprice: number | null;
        inspection: number | null;
        goodsurl: string | null;
        goodsname: string;
        extend: string | null;
      }>
    >`SELECT oid, uid, tid, sid, type, state, goodsprice, goodsprice1, goodsnum, bargainprice, sendprice, inspection, goodsurl, goodsname, extend
       FROM dg_order WHERE oid IN (${LegacyPrismaRuntime.join(oids)}) AND deleted_at IS NULL FOR UPDATE`;
  }

  /** 按 tid 读金额组（旧 getAmountCalculationGroupOrders：排除无效态 + orderBy oid asc）。**含软删**（旧 Order 无全局 scope）。 */
  async findActiveGroupOrdersByTid(tx: LegacyPrisma.TransactionClient, tid: string) {
    return tx.dg_order.findMany({
      where: { tid, state: { notIn: [6, 10, 11] } },
      select: {
        oid: true,
        tid: true,
        sid: true,
        state: true,
        goodsprice: true,
        goodsprice1: true,
        goodsnum: true,
        bargainprice: true,
        sendprice: true,
      },
      orderBy: { oid: 'asc' },
    });
  }

  /** 组内全部清 sendprice（旧 `whereIn(oid)->update(['sendprice' => 0.0])`）。**含软删**。 */
  async clearSendprice(tx: LegacyPrisma.TransactionClient, oids: number[]): Promise<void> {
    await tx.dg_order.updateMany({ where: { oid: { in: oids } }, data: { sendprice: 0 } });
  }

  /** 单独给接收者回写总额（旧 `where(oid)->update(['sendprice' => total])`）。**含软删**。 */
  async setSendprice(tx: LegacyPrisma.TransactionClient, oid: number, sendprice: number): Promise<void> {
    await tx.dg_order.updateMany({ where: { oid }, data: { sendprice } });
  }

  /**
   * 取消收尾更新（旧 `$order->update(['bargainprice' => 0, 'state' => 10, 'uptime' => time()])`）。
   * 金额字段变更会触发旧模型的同步事件——新系统由 service 显式调 amount-sync（deferred flush）。
   */
  async finalizeCancel(tx: LegacyPrisma.TransactionClient, oid: number, uptimeSec: number): Promise<void> {
    // updateMany：Prisma update 会回读全列（含本地 dump 缺失的生产新列 → P2022），返回值无人消费
    await tx.dg_order.updateMany({
      where: { oid },
      data: { bargainprice: 0, state: 10, uptime: uptimeSec },
    });
  }

  // -----------------------------------------------------------------------
  // 余额动账（旧 User::addMoney 1:1 —— 事务内 increment + 流水）
  // -----------------------------------------------------------------------

  /**
   * 加余额 + 写 dg_record（旧 addMoney：increment → login_limit_warning=0 →
   * last_balance_changed_at=now → Record::create）。**调用方已在事务内**。
   * accountmoney 快照 = 动账前余额 + 变动额（旧 $this->money + $money，动账前读值）。
   */
  async addBalanceRecord(
    tx: LegacyPrisma.TransactionClient,
    input: {
      uid: number;
      uname: string;
      /** 变动额（正 = 收入 type=2，负 = 支出 type=1） */
      amount: number;
      /** Record::RECORD_ACTION_4 */
      action: number;
      remark: string;
      sn: string;
      oid: number;
      ordflag: number;
      /** extend JSON 字符串（空数组 → '[]'，旧 json_encode 语义） */
      extendJson: string;
      nowSec: number;
      /** 动账前余额（调用方锁行后传入，禁再读一次造成竞态） */
      balanceBefore: number;
      /** dfflag == 1 时 ordflag 强制 3（旧 addMoney 矫正逻辑） */
      dfflag: number | null;
    },
  ): Promise<void> {
    await tx.dg_users.update({
      where: { uid: input.uid },
      data: {
        money: { increment: input.amount },
        login_limit_warning: 0,
        last_balance_changed_at: new Date(input.nowSec * 1000),
      },
    });

    await tx.dg_record.create({
      data: {
        uid: input.uid,
        uname: input.uname,
        type: input.amount > 0 ? 2 : 1, // Record::TYPE_INCR / TYPE_DECR
        action: input.action,
        money: input.amount,
        accountmoney: input.balanceBefore + input.amount,
        remark: input.remark,
        sn: input.sn,
        addtime: input.nowSec,
        oid: input.oid,
        ordflag: input.dfflag === 1 ? 3 : input.ordflag,
        extend: input.extendJson,
      },
    });
  }

  // -----------------------------------------------------------------------
  // 1688 支付 webhook（旧 OrderController::update1688PaidOrders 1:1 —— S19 范本之一）
  // -----------------------------------------------------------------------

  /**
   * 1688 支付推进（旧 :817-838 **逐条 1:1**）：
   * 条件 UPDATE（tid + state in [1,2] + goodssite='1688' + type=1）→ state=2、
   * conttime 条件回填（IF(IFNULL(conttime,0)<=0, now, conttime) 首次支付时间不覆盖）、
   * uptime=now、extend JSON_SET payTime。**幂等性 = 条件本身**（已推进行不再匹配）。
   * 返回 affected 行数（旧 $affected；无行命中不是错误——事件先于建单到达是常态）。
   */
  async update1688PaidOrders(db: Db, tid: string, payTimeSec: number, nowSec: number): Promise<number> {
    const affected = await db.$executeRawUnsafe(
      `UPDATE dg_order SET
         state = 2,
         conttime = IF(IFNULL(\`conttime\`, 0) <= 0, ?, \`conttime\`),
         uptime = ?,
         extend = JSON_SET(COALESCE(\`extend\`, '{}'), '$.payTime', ?)
       WHERE tid = ? AND state IN (1, 2) AND goodssite = '1688' AND type = 1`,
      nowSec, nowSec, payTimeSec, tid,
    );
    return affected;
  }

  // -----------------------------------------------------------------------
  // 1688 物流建档（旧 tryGetOrders / DgArrival 1:1；webhook-1688-logistics 编排）
  // -----------------------------------------------------------------------

  /** 按 tid 查订单（含软删——旧 Order 无全局 scope；旧 tryGetOrders 同款不过滤） */
  async listByTid(db: Db, tid: string): Promise<Array<{ oid: number; expressno: string | null }>> {
    const rows = await db.dg_order.findMany({
      where: { tid },
      select: { oid: true, expressno: true },
      orderBy: { oid: 'asc' },
    });
    return rows.map((r) => ({ oid: r.oid, expressno: r.expressno }));
  }

  /**
   * 直建转运订单（旧 tryGetOrders 的 Order::insert 1:1）：**state=3（SEND 入库态）**、
   * type=2 转运、goodssite='1688'、expressno=mailNo。⚠ dg_order.memberid 生产 NOT NULL
   * 无默认（非严格模式落 ''）——显式补 ''；yanhuo* 等必填空串列（information_schema 核实）同补。
   */
  async createZhuanyunOrders(
    db: Db,
    input: {
      tid: string;
      uid: number;
      uname: string;
      items: Array<{ auctionUrl?: string; auctionTitle?: string; pictureUrl?: string; quantity?: number; skuName?: string }>;
      expressno: string;
    },
  ): Promise<Array<{ oid: number; expressno: string | null }>> {
    const nowSec = Math.floor(Date.now() / 1000);
    const oids: number[] = [];
    for (const item of input.items) {
      const row = await db.dg_order.create({
        data: {
          uid: input.uid,
          uname: input.uname,
          memberid: '', // 非严格模式等价（旧 insert 不传 memberid）
          tid: input.tid,
          goodssite: '1688',
          goodsurl: item.auctionUrl ?? '',
          goodsname: item.auctionTitle ?? '',
          goodsimg: item.pictureUrl ?? '',
          goodsnum: item.quantity ?? 0,
          sku_name: item.skuName ?? '',
          type: 2, // ORDER_TYPE_ZHUANYUN
          state: 3, // STATE_SEND——旧建单即入库状态（docs/plans/09 §1.1）
          sendprice: 0,
          addtime: nowSec,
          expressno: input.expressno,
          // NOT NULL 无默认列（information_schema 核实）——非严格模式空串等价
          yanhuofba: '', yanhuojinyun: '', yanhuozengzhi: '', yanhuoasin: '', yanhuofnsku: '',
          baozhuang: '', hbbaozhuang: '', baonum: '', SKU: '', shangpin_sku: '', FNSKU: '',
          shangpin_fnsku: '', name: '', shangpin_name: '', amazon: '', putong: '',
          shangpin_amazon: '', fuzhuang: '', tiebiao: '', huanbaoz: '', qita: '',
        },
        select: { oid: true },
      });
      oids.push(row.oid);
    }
    return this.listByTid(db, input.tid);
  }

  /** 回写运单 sid（旧 Order::whereIn(oid)->update(['sid' => ...])；含软删同旧） */
  async attachSid(db: Db, oids: number[], sid: number): Promise<void> {
    await db.dg_order.updateMany({ where: { oid: { in: oids } }, data: { sid: String(sid) } });
  }

  /** expressno 多单号空格合并回写（旧 Order::whereIn(oid)->update(['expressno' => ...])） */
  async updateExpressno(db: Db, oids: number[], expressno: string): Promise<void> {
    await db.dg_order.updateMany({ where: { oid: { in: oids } }, data: { expressno } });
  }

  /**
   * 入库登记 firstOrCreateRecord（旧 DgArrival::firstOrCreateRecord 1:1，表 v2_logistic_domestic）：
   * expressno 命中即复用；未命中按 params 建（package_info 缺省 []）。
   */
  async firstOrCreateArrival(
    db: Db,
    input: { expressno: string; providerCode: string; state: number; type: number },
  ): Promise<{ id: number }> {
    const existing = await db.v2_logistic_domestic.findFirst({
      where: { expressno: input.expressno },
      select: { id: true },
    });
    if (existing) return existing;
    const row = await db.v2_logistic_domestic.create({
      data: {
        parent_id: 0, // NOT NULL 无默认——旧 insert 同样不传（非严格落 0）
        expressno: input.expressno,
        provider_code: input.providerCode,
        state: input.state,
        type: input.type,
        package_info: '[]',
        create_date: new Date(),
      },
      select: { id: true },
    });
    return row;
  }

  /** pivot syncWithoutDetaching（旧 $record->orders()->syncWithoutDetaching；唯一键撞键忽略） */
  async attachArrivalOrder(db: Db, arrivalId: number, oid: number, createdAtSec: number): Promise<void> {
    await db.$executeRawUnsafe(
      `INSERT INTO v2_relation_order_and_logistic_domestic (logistic_domestic_id, oid, created_at)
       VALUES (?, ?, FROM_UNIXTIME(?))
       ON DUPLICATE KEY UPDATE logistic_domestic_id = logistic_domestic_id`,
      BigInt(arrivalId), BigInt(oid), createdAtSec,
    );
  }

  // -----------------------------------------------------------------------
  // 会员订单列表（旧 OrderListInput::buildQuery + ListOrderV2Query 1:1）
  // -----------------------------------------------------------------------

  /** 用户 dfflag（dfflag 用户列表强制 type=3） */
  async getUserDfFlag(db: Db, uid: number): Promise<boolean> {
    const row = await this.db.dg_users.findUnique({ where: { uid }, select: { dfflag: true } });
    return (row?.dfflag ?? 0) === 1;
  }

  /** mark_flag 位条件筛 oid（Prisma 无位运算 → raw 小查询；value∈{0,1}，position 0=favorite/2=arrival） */
  async listOidsByMarkFlag(db: Db, uid: number, position: number, value: number): Promise<number[]> {
    const rows = await db.$queryRawUnsafe<{ oid: number }[]>(
      'SELECT oid FROM dg_order WHERE uid = ? AND deleted_at IS NULL AND ((mark_flag & (0b11 << ?)) >> ?) = ?',
      uid, position, position, value,
    );
    return rows.map((r) => Number(r.oid));
  }

  /** v2_order_detail.id == dg_order.oid（旧 hasOne(V2OrderDetail,'id','oid')）：日语商品名命中集 */
  async listOidsByDetailNameLike(db: Db, keyword: string): Promise<number[]> {
    const rows = await db.v2_order_detail.findMany({
      where: { goods_name_trans: { contains: keyword } },
      select: { id: true },
    });
    return rows.map((r) => Number(r.id));
  }

  /** detail 投影（id == oid）：goods_name_trans / sku_trans / instant_chat_tag */
  async findOrderDetails(db: Db, oids: number[]) {
    if (oids.length === 0) return new Map<number, { goods_name_trans: string | null; sku_trans: unknown; instant_chat_tag: string | null }>();
    const rows = await db.v2_order_detail.findMany({
      where: { id: { in: oids } },
      select: { id: true, goods_name_trans: true, sku_trans: true, instant_chat_tag: true },
    });
    return new Map(rows.map((r) => [Number(r.id), r]));
  }

  /** question 视图：yunjiao 未读（xbox='b'）命中的 oid 集（旧 Yunjiao::where(uid)->where(xbox,UNREAD)） */
  async listOidsByUnreadChat(db: Db, uid: number): Promise<number[]> {
    const rows = await db.dg_yunjiao.findMany({ where: { uid, xbox: 'b' }, select: { oid: true } });
    return [...new Set(rows.map((r) => Number(r.oid)))];
  }

  /** splitId 过滤：dg_order_split.oid = splitId → spoid 集（旧 OrderSplit::where('oid',..)->pluck('spoid')） */
  async listSpuIdsBySplitOid(db: Db, splitOid: number): Promise<number[]> {
    const rows = await db.dg_order_split.findMany({ where: { oid: splitOid }, select: { spoid: true } });
    return rows.map((r) => Number(r.spoid)).filter((v) => v > 0);
  }

  /** notInEcommerceSkuIds：关联表反查已绑 oid 集（旧 ProductSkuAndOrderRelation pluck oid） */
  async listOidsByEcommerceSkuIds(db: Db, skuIds: number[]): Promise<number[]> {
    const rows = await db.v2_relation_ecommerce_product_sku_and_order.findMany({
      where: { ecommerce_product_sku_id: { in: skuIds } },
      select: { oid: true },
    });
    return rows.map((r) => Number(r.oid));
  }

  /**
   * 列表主查询（**排除软删** = OrderWithoutTrashed，1:1）。
   * where 由 service 组装（Prisma DgOrderWhereInput 接近旧 query builder 形态）；
   * 排序 `oid + 1 desc` 与 `oid desc` 等价（oid 本就是 Int，+1 是旧代码绕字符串排序的 trick）。
   */
  async listMemberOrders(
    db: Db,
    where: LegacyPrisma.dg_orderWhereInput,
    page: number,
    limit: number,
  ): Promise<{ rows: ListOrderRow[]; total: number }> {
    // OrderWithoutTrashed 口径：列表恒排除软删（service 的 where 不携带此条件，在此强制）
    const effectiveWhere: LegacyPrisma.dg_orderWhereInput = { AND: [{ deleted_at: null }, where] };
    const [rows, total] = await Promise.all([
      db.dg_order.findMany({
        where: effectiveWhere,
        select: {
          oid: true, uid: true, type: true, state: true, sid: true, expressno: true,
          goodsid: true, goodsname: true, goodsurl: true, goodsimg: true,
          goodssize: true, goodscolor: true, goodsseller: true, goodssite: true,
          sku_name: true, ship: true, goodsprice: true, goodsprice1: true, goodsnum: true,
          item_location: true, sendprice: true, goodsremark: true, orderremark: true,
          yanhuofba: true, yanhuoasin: true, FNSKU: true, outid: true, tid: true,
          addtime: true, arrivetime: true, dfstoremode: true, mark_flag: true, extend: true,
        },
        orderBy: { oid: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.dg_order.count({ where: effectiveWhere }),
    ]);
    return { rows: rows as ListOrderRow[], total };
  }
}

/** 旧 query builder 的 Prisma where 形态（service 组装用；禁泄漏出域） */
export type LegacyWhere = LegacyPrisma.dg_orderWhereInput;

/** 列表行（select 子集；金额列 Prisma 回 number/Decimal，投影在 service 统一转字符串） */
type Decimal = { toString(): string; toNumber(): number };
export type ListOrderRow = {
  oid: number; uid: number; type: number | null; state: number | null; sid: string | null;
  expressno: string | null; goodsid: string | null; goodsname: string | null; goodsurl: string | null;
  goodsimg: string | null; goodssize: string | null; goodscolor: string | null; goodsseller: string | null;
  goodssite: string | null; sku_name: string; ship: number | null; goodsprice: number;
  goodsprice1: number | Decimal; goodsnum: number | null; item_location: string | null; sendprice: number;
  goodsremark: string | null; orderremark: string | null; yanhuofba: string; yanhuoasin: string;
  FNSKU: string; outid: string | null; tid: string; addtime: number | null; arrivetime: number | null;
  dfstoremode: number | null; mark_flag: number | null; extend: string | null;
};

/** 生产事务运行器（组合根用；域内禁自带连接 → 由此出口提供真事务语义） */
export function runInOrderTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return legacyPrisma.$transaction(fn);
}
