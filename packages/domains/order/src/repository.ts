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

/** 下单链路购物车行（listCartsForOrder 列集；Cart::toArray 的搬运源） */
export type CartForOrderRow = Awaited<ReturnType<OrderRepository['listCartsForOrder']>>[number];

/** chrome 回传订单行（listOrdersForChrome 列集；旧 getSkuName 依赖 goodssize/goodscolor 兜底） */
export type ChromeOrderRow = Awaited<ReturnType<OrderRepository['listOrdersForChrome']>>[number];

/** 建单入参（旧 `Order::create($order)`：$order = cart 全列（去 gid/anonymous）+ 覆盖项） */
export type CreateOrderData = LegacyPrisma.dg_orderCreateInput;

/**
 * 加购入参（旧 `Cart::create($cart)`：prepareCarts 组装的列 + 平台实价覆盖后的值）。
 * 只需给业务列，24 个无默认串列由 `CART_NO_DEFAULT_EMPTY_COLS` 补 `''`。
 */
export type CreateCartData = Partial<LegacyPrisma.dg_cartCreateInput>;

/**
 * dg_cart 中**无默认值且 NOT NULL** 的串列（information_schema 核实 24 列）。
 * 旧系统靠 MySQL 非严格模式落 `''`，此处显式等价复现（见 createCart 注释）。
 */
const CART_NO_DEFAULT_EMPTY_COLS = {
  yanhuofba: '', yanhuojinyun: '', yanhuozengzhi: '', yanhuoasin: '', yanhuofnsku: '',
  baozhuang: '', hbbaozhuang: '', baonum: '', SKU: '', FNSKU: '', name: '', amazon: '',
  putong: '', fuzhuang: '', tiebiao: '', huanbaoz: '', qita: '',
  var1: '', var2: '', var3: '', var4: '', var5: '', var6: '', var7: '',
} as const;

/**
 * 旧 `Cart::$fillable` 白名单（正本 `haiou/backend/app/Models/Cart.php:30-107`）。
 * ★ `Cart::create($cart)` 只落白名单内的键，其余**静默丢弃**（不是报错）——
 *   例：prepareCarts 塞进来的 `miId`（dg_cart 无此列）就是这样被丢掉的。
 *   改列名必须同步改这里，否则 R1 与旧系统会静默分叉。
 */
export const CART_FILLABLE: ReadonlySet<string> = new Set([
  'tid', 'anonymous', 'uid', 'uname', 'supplier_product_id', 'goodsurl', 'goodsname',
  'goodsprice', 'one_piece_price', 'offer_price', 'retail_price', 'sendprice', 'goodsnum',
  'goodsimg', 'goodssize', 'goodscolor', 'goodsseller', 'min_order_quantity', 'sellerurl',
  'goodssite', 'siteurl', 'expressno', 'type', 'goodsremark', 'addtime', 'goodsid',
  'proprice', 'TermQty', 'TermPrice', 'TermShipping', 'inspection', 'ship', 'sku_name',
  'yanhuofba', 'yanhuojinyun', 'yanhuozengzhi', 'yanhuoasin', 'yanhuofnsku',
  'baozhuang', 'hbbaozhuang', 'baonum', 'SKU', 'FNSKU', 'shangpin_fnsku', 'shangpin_sku',
  'name', 'shangpin_name', 'shangpin_amazon', 'amazon', 'putong', 'fuzhuang', 'tiebiao',
  'huanbaoz', 'qita', 'var1', 'var2', 'var3', 'var4', 'var5', 'var6', 'var7', 'var8',
  'var9', 'var10', 'var11', 'var12', 'outid', 'goods_name_trans', 'sku_trans',
  'add_from', 'add_from_memo',
]);

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
  // 购物车读路径（旧 listCart / getCartMoney）：dg_cart 属主 = order 域；v2_supplier_product
  // 属主 = purchase 域（docs/plans/07 §四），只读经 purchase 域 SupplierCatalogPort（TODO #17）
  // -----------------------------------------------------------------------

  /** 购物车行（select 子集：列表 + 金额计算全部所需列） */
  async listCarts(
    db: Db,
    where: { uid: number; gids?: number[]; types: number[] },
  ): Promise<Array<{
    gid: number; uid: number; uname: string | null; type: number | null;
    supplier_product_id: number | null; goodsurl: string; goodsname: string; goodsprice: number;
    offer_price: number; retail_price: number | null; one_piece_price: number; sendprice: number;
    goodsnum: number; min_order_quantity: number; goodsimg: string | null; goodssize: string | null;
    goodscolor: string | null; goodsseller: string | null; goodssite: string | null;
    expressno: string | null; goodsremark: string | null; goodsid: string | null;
    ship: number | null; sku_name: string; goods_name_trans: string | null; sku_trans: unknown;
    yanhuofba: string; yanhuoasin: string; yanhuofnsku: string; yanhuozengzhi: string; outid: string | null;
    add_from: number | null; addtime: number | null;
    var1: string; var2: string; var3: string; var4: string; var5: string; var6: string;
    var7: string; var8: string | null; var9: string | null; var10: string | null; var11: string | null; var12: string | null;
  }>> {
    const rows = await db.dg_cart.findMany({
      where: {
        uid: where.uid,
        ...(where.gids ? { gid: { in: where.gids } } : {}),
        type: { in: where.types },
      },
      select: {
        gid: true, uid: true, uname: true, type: true,
        supplier_product_id: true, goodsurl: true, goodsname: true, goodsprice: true,
        offer_price: true, retail_price: true, one_piece_price: true, sendprice: true,
        goodsnum: true, min_order_quantity: true, goodsimg: true, goodssize: true,
        goodscolor: true, goodsseller: true, goodssite: true,
        expressno: true, goodsremark: true, goodsid: true,
        ship: true, sku_name: true, goods_name_trans: true, sku_trans: true,
        yanhuofba: true, yanhuoasin: true, yanhuofnsku: true, yanhuozengzhi: true, outid: true,
        add_from: true, addtime: true,
        var1: true, var2: true, var3: true, var4: true, var5: true, var6: true,
        var7: true, var8: true, var9: true, var10: true, var11: true, var12: true,
      },
      orderBy: { addtime: 'desc' },
    });
    return rows;
  }

  // -----------------------------------------------------------------------
  // 下单链路（旧 CreateOrderFromCartService + Cart::cartToOrder）
  // -----------------------------------------------------------------------

  /**
   * 下单装载购物车（旧 `Cart::with([...])->whereIn('gid', ids)->get()` 1:1）：
   * **不过滤 uid / type**（归属守卫在 service，与旧 handle() 同）。
   */
  async listCartsForOrder(db: Db, gids: number[]) {
    if (gids.length === 0) return [];
    return db.dg_cart.findMany({
      where: { gid: { in: gids } },
      select: {
        gid: true, uid: true, uname: true, type: true, tid: true,
        supplier_product_id: true, goodsurl: true, goodsname: true, goodsprice: true,
        offer_price: true, retail_price: true, one_piece_price: true, sendprice: true,
        goodsnum: true, min_order_quantity: true, goodsimg: true, goodssize: true,
        goodscolor: true, goodsseller: true, sellerurl: true, goodssite: true, siteurl: true,
        expressno: true, goodsremark: true, goodsid: true, proprice: true,
        TermQty: true, TermPrice: true, TermShipping: true, inspection: true,
        ship: true, sku_name: true, goods_name_trans: true, sku_trans: true,
        yanhuofba: true, yanhuojinyun: true, yanhuozengzhi: true, yanhuoasin: true, yanhuofnsku: true,
        baozhuang: true, hbbaozhuang: true, baonum: true, SKU: true, FNSKU: true,
        shangpin_fnsku: true, shangpin_sku: true, name: true, shangpin_name: true,
        shangpin_amazon: true, amazon: true, putong: true, fuzhuang: true, tiebiao: true,
        huanbaoz: true, qita: true, outid: true, add_from: true, add_from_memo: true, addtime: true,
        var1: true, var2: true, var3: true, var4: true, var5: true, var6: true,
        var7: true, var8: true, var9: true, var10: true, var11: true, var12: true,
      },
      orderBy: { gid: 'asc' },
    });
  }

  /**
   * 行锁购物车（旧 lockCartsForUpdate：`Cart::with([...])->where(uid)->whereIn(gid)
   * ->orderBy('gid')->lockForUpdate()->get()`）。
   *
   * ⚠ 只锁购物车行（FOR UPDATE）——店铺名（v2_supplier_shop.title/nickname）与商品 shop_id 是
   * **参考数据**，与购物车行锁**无一致性要求**，已移出事务、改走 purchase 域 `SupplierCatalogPort`
   * 在调用方（placeOrdersFromCarts）事务外读取（TODO #17，方案①）。旧代码「在 tx 内」只是
   * Laravel 单连接请求的副产物，非正确性需求。
   */
  async lockCartsForUpdate(
    tx: LegacyPrisma.TransactionClient,
    uid: number,
    gids: number[],
  ): Promise<CartForOrderRow[]> {
    const rows = await tx.dg_cart.findMany({
      where: { uid, gid: { in: gids } },
      select: {
        gid: true, uid: true, uname: true, type: true, tid: true,
        supplier_product_id: true, goodsurl: true, goodsname: true, goodsprice: true,
        offer_price: true, retail_price: true, one_piece_price: true, sendprice: true,
        goodsnum: true, min_order_quantity: true, goodsimg: true, goodssize: true,
        goodscolor: true, goodsseller: true, sellerurl: true, goodssite: true, siteurl: true,
        expressno: true, goodsremark: true, goodsid: true, proprice: true,
        TermQty: true, TermPrice: true, TermShipping: true, inspection: true,
        ship: true, sku_name: true, goods_name_trans: true, sku_trans: true,
        yanhuofba: true, yanhuojinyun: true, yanhuozengzhi: true, yanhuoasin: true, yanhuofnsku: true,
        baozhuang: true, hbbaozhuang: true, baonum: true, SKU: true, FNSKU: true,
        shangpin_fnsku: true, shangpin_sku: true, name: true, shangpin_name: true,
        shangpin_amazon: true, amazon: true, putong: true, fuzhuang: true, tiebiao: true,
        huanbaoz: true, qita: true, outid: true, add_from: true, add_from_memo: true, addtime: true,
        var1: true, var2: true, var3: true, var4: true, var5: true, var6: true,
        var7: true, var8: true, var9: true, var10: true, var11: true, var12: true,
      },
      orderBy: { gid: 'asc' },
    });
    // Prisma 无 lockForUpdate：同一列集补一条 raw FOR UPDATE 取锁（旧行锁语义）
    if (rows.length > 0) {
      await tx.$queryRaw`SELECT gid FROM dg_cart WHERE uid = ${uid} AND gid IN (${LegacyPrismaRuntime.join(rows.map((r) => r.gid))}) ORDER BY gid FOR UPDATE`;
    }
    return rows;
  }

  /** 阶梯价回写购物车（旧 updateTierPricesForCarts 的 `$cart->save()`） */
  async updateCartGoodsprice(db: Db, gid: number, goodsprice: number): Promise<void> {
    await db.dg_cart.updateMany({ where: { gid }, data: { goodsprice } });
  }

  /**
   * 砍价记录（旧 `BargainRecord::where(goodid)->where(goodstype)->first()`）。
   * ⚠ `dg_bargain_record.goodid` 是 **BigInt**（Prisma 映射）→ 非数字 goodsid 直接判无砍价
   * （旧 MySQL 隐式转 0 会命中 goodid=0 的行，实际不存在——等价）。
   */
  async findBargain(db: Db, goodsId: string, goodsType: number): Promise<{ bgprice: number | null } | null> {
    const numeric = /^\d+$/.test(goodsId) ? BigInt(goodsId) : null;
    if (numeric === null) return null;
    const row = await db.dg_bargain_record.findFirst({
      where: { goodid: numeric, goodstype: goodsType },
      select: { bgprice: true },
      orderBy: { id: 'asc' },
    });
    if (!row) return null;
    return { bgprice: row.bgprice === null ? null : Number(row.bgprice) };
  }

  /**
   * 建单（旧 Cart::cartToOrder 的 `Order::create`）；返回 payOrder / 后处理所需列。
   * ⚠ 列集固定：本地 dump 缺生产新列（buyer_remark_icon/buyer_memo），禁 select 它们。
   */
  async createOrder(db: Db, data: CreateOrderData) {
    return db.dg_order.create({
      data,
      select: {
        oid: true, type: true, state: true, uid: true, uname: true,
        goodsurl: true, goodsname: true, goodsprice: true, goodsnum: true,
        goodsimg: true, goodsseller: true, goodssite: true, expressno: true,
        extend: true,
      },
    });
  }

  /** 删除购物车行（旧 `$cart->delete()`） */
  async deleteCart(db: Db, gid: number): Promise<void> {
    await db.dg_cart.delete({ where: { gid } });
  }

  /**
   * 一件代发：回写会员发件信息（旧 `$user->dfsendaddress/tel/name; $user->save()`）。
   * ⚠ dg_users 属主 = member 域，但旧代码在下单事务内写——与 addBalanceRecord 同款
   * 事务内直写（domain 间不拆事务；R3 拆库时改为跨域端口 + 事务消息）。
   */
  async updateDfSendInfo(
    tx: LegacyPrisma.TransactionClient,
    uid: number,
    info: { dfsendaddress: string; dfsendtel: string; dfsendname: string },
  ): Promise<void> {
    await tx.dg_users.update({ where: { uid }, data: info });
  }

  /**
   * 行锁读用户（下单链路扩列版：payOrder 需要 memberid/email/belong_company）。
   * 与 lockUser 分列集是为了两条链路各自最小列集（旧代码也是各读各的模型实例）。
   */
  async lockUserForOrder(tx: LegacyPrisma.TransactionClient, uid: number) {
    const rows = await tx.$queryRaw<
      Array<{
        uid: number; uname: string; memberid: string | null; email: string | null;
        money: number; dfflag: number | null; utype: number | null; validity: number;
        dffee: number | null; belong_company: string | null;
      }>
    >`SELECT uid, uname, memberid, email, money, dfflag, utype, validity, dffee, belong_company
       FROM dg_users WHERE uid = ${uid} FOR UPDATE`;
    return rows[0] ?? null;
  }

  // -----------------------------------------------------------------------
  // send-order 域端口读面（dg_order 属主 = order 域；send-order 列表经端口消费）
  // -----------------------------------------------------------------------

  /** 运单侧订单摘要（旧 with(['orders']) 需要的列：mark_flag/yanhuofba/type/sendprice） */
  async listBriefBySids(db: Db, sids: number[]): Promise<Map<number, Array<{
    oid: number; sid: string | null; markFlag: number | null; yanhuofba: string; type: number | null; sendprice: number;
  }>>> {
    if (sids.length === 0) return new Map();
    const rows = await db.dg_order.findMany({
      where: { sid: { in: sids.map(String) } },
      select: { oid: true, sid: true, mark_flag: true, yanhuofba: true, type: true, sendprice: true },
    });
    const map = new Map<number, Array<{ oid: number; sid: string | null; markFlag: number | null; yanhuofba: string; type: number | null; sendprice: number }>>();
    for (const r of rows) {
      if (r.sid === null) continue;
      const key = Number(r.sid);
      if (!Number.isInteger(key)) continue;
      const list = map.get(key) ?? [];
      list.push({ oid: r.oid, sid: r.sid, markFlag: r.mark_flag, yanhuofba: r.yanhuofba, type: r.type, sendprice: Number(r.sendprice) });
      map.set(key, list);
    }
    return map;
  }

  /**
   * 运单列表 orderKeyword 反查（旧 SendOrderListInput :101-121 1:1）：
   * uid + sid>0 + 六列 like + dfflag type 分流（DF 加 storeMode——**该条件为死代码**，
   * GraphQL 未声明字段永不传入，此处端口入参不含 storeMode）→ pluck sid unique。
   */
  async listSidsByShipmentKeyword(db: Db, uid: number, keyword: string, isDf: boolean): Promise<number[]> {
    const kw = { contains: keyword };
    // ⚠ 旧 `oid LIKE '%kw%'` 对 Int 列做隐式转换匹配——Prisma 无法 LIKE 整数列，
    // 收敛为「纯数字 → 精确等值；否则跳过 oid 条件」（S28 同族，双跑 diff 会显示子串场景差异）
    const oidFilter: { oid: { equals: number } } | null = /^\d+$/.test(keyword) ? { oid: { equals: Number(keyword) } } : null;
    const where: LegacyPrisma.dg_orderWhereInput = {
      uid,
      sid: { gt: '0' },
      OR: [
        ...(oidFilter ? [oidFilter] : []),
        { goodsname: kw },
        { outid: kw },
        { yanhuofnsku: kw },
        { goodsremark: kw },
        { yanhuoasin: kw },
      ],
      ...(isDf ? { type: 3 } : { type: { in: [1, 2] } }),
    };
    const rows = await db.dg_order.findMany({ where, select: { sid: true } });
    const sids = new Set<number>();
    for (const r of rows) {
      const v = Number(r.sid);
      if (Number.isInteger(v) && v > 0) sids.add(v);
    }
    return [...sids];
  }

  // -----------------------------------------------------------------------
  // 发货回传（旧 updateExpressNoForChrome / batchUpdateExpressno 1688·淘宝分支 1:1）
  // -----------------------------------------------------------------------

  /** chrome 面：按 tid 查**已付款**订单（旧 :481 无 goodssite 过滤——1:1） */
  async listPaidByTid(db: Db, tid: string): Promise<Array<{ oid: number }>> {
    const rows = await db.dg_order.findMany({
      where: { tid, state: 2 },
      select: { oid: true },
      orderBy: { oid: 'desc' },
    });
    return rows.map((r) => ({ oid: r.oid }));
  }

  /** 批量面：已付款且**单号为空**的订单（旧 :683-688 filter 语义） */
  async listPaidWithoutExpressno(db: Db, tid: string, platform: string): Promise<Array<{ oid: number }>> {
    const rows = await db.dg_order.findMany({
      where: { tid, goodssite: platform, state: 2 },
      select: { oid: true, expressno: true },
      orderBy: { oid: 'desc' },
    });
    return rows.filter((r) => !r.expressno).map((r) => ({ oid: r.oid }));
  }

  /** 批量面：已发货但**单号与目标串不一致**的订单（旧 :690-697；isDelayedFix 日志差异 R1 略） */
  async listSentWithDifferentExpressno(db: Db, tid: string, platform: string, expressStr: string): Promise<Array<{ oid: number }>> {
    const rows = await db.dg_order.findMany({
      where: { tid, goodssite: platform, state: 3 },
      select: { oid: true, expressno: true },
      orderBy: { oid: 'desc' },
    });
    return rows.filter((r) => `${r.expressno ?? ''}` !== `${expressStr}`).map((r) => ({ oid: r.oid }));
  }

  /** 幂等判定集：tid+平台全部订单的单号（旧 :712-720 every(normalized)） */
  async listExpressnoByTidAndPlatform(db: Db, tid: string, platform: string): Promise<Array<string | null>> {
    const rows = await db.dg_order.findMany({
      where: { tid, goodssite: platform },
      select: { expressno: true },
    });
    return rows.map((r) => r.expressno);
  }

  /**
   * 发货更新（旧 Order::updateOrder 对本场景的**有效语义**子集）：
   * state 2→3（两侧均为活跃态）无金额字段 → dispatchSync 空转（旧 afterCommit 后
   * changedFields 非金额字段直接 return）→ 此处只做 bulk update。
   * ⚠ saveBatchUpdateRecord（审计日志 channel+admin_operation_log）→ R1 走 auditLog
   * 端口（S27：webhook 面无 admin 会话，旧 Admin::user() 为空本就只落 channel 日志）。
   */
  async applyShipment(
    db: Db,
    oids: number[],
    data: { state?: number; waytime?: number; expressno: string },
  ): Promise<void> {
    await db.dg_order.updateMany({ where: { oid: { in: oids } }, data });
  }

  // -----------------------------------------------------------------------
  // chrome 回传（旧 webhookForChrome → validateOrderByOidAndTradeId / saveOrderInfo /
  // BatchUpdateOrder 有效子集 1:1）
  // -----------------------------------------------------------------------

  /** 回传校验/保存需要的订单列（旧 `Order::whereIn('oid',$oids)->orderBy('oid','desc')->get()` 的窄投影） */
  async listOrdersForChrome(db: Db, oids: number[]) {
    return db.dg_order.findMany({
      where: { oid: { in: oids } },
      select: {
        oid: true, tid: true, sid: true, state: true, type: true,
        goodsid: true, goodsname: true, goodssite: true,
        goodsprice: true, goodsprice1: true, goodsnum: true,
        sendprice: true, bargainprice: true,
        sku_name: true, goodscolor: true, goodssize: true,
        goodsseller: true, payid: true,
      },
      orderBy: { oid: 'desc' },
    });
  }

  /** 金额字段可改性守卫的读集（旧 `Order::whereIn('oid',$keys)->get(['oid','state'])`） */
  async listOrderStates(db: Db, oids: number[]): Promise<Array<{ oid: number; state: number | null }>> {
    return db.dg_order.findMany({ where: { oid: { in: oids } }, select: { oid: true, state: true } });
  }

  /** 旧 `Order::whereIn('oid',$ids)->update($data)`（query builder，不触发模型事件） */
  async updateOrdersForChrome(
    db: Db,
    oids: number[],
    data: {
      tid?: string;
      bargainprice?: number;
      sendprice?: number;
      payid?: string;
      paytime?: number;
      purchase_type?: number;
    },
  ): Promise<void> {
    await db.dg_order.updateMany({ where: { oid: { in: oids } }, data });
  }

  /** 单行更新（金额承载单）——旧 `Order::updateOrder($oid, $data)` 的落库部分 */
  async updateOrderForChrome(
    db: Db,
    oid: number,
    data: { bargainprice?: number; sendprice?: number },
  ): Promise<void> {
    await db.dg_order.updateMany({ where: { oid }, data });
  }

  /** 旧 `AdminOperationLog::recordOperation(ACTION_UPDATE_ORDER, keys)` 的留痕（R1 走端口，见 S27 族） */
  async touchOrdersUptime(db: Db, oids: number[], uptimeSec: number): Promise<void> {
    await db.dg_order.updateMany({ where: { oid: { in: oids } }, data: { uptime: uptimeSec } });
  }

  /** 旧 `V2OrderDetail::updateOrCreate(['id'=>$oid], ['coupon_fee'=>$couponFee])` */
  async upsertOrderDetailCouponFee(db: Db, oid: number, couponFee: number, createdAt: Date): Promise<void> {
    const existing = await db.v2_order_detail.findUnique({ where: { id: oid }, select: { id: true } });
    if (existing) {
      await db.v2_order_detail.update({ where: { id: oid }, data: { coupon_fee: couponFee, updated_at: createdAt } });
      return;
    }
    await db.v2_order_detail.create({
      data: { id: oid, coupon_fee: couponFee, created_at: createdAt, updated_at: createdAt },
    });
  }

  /** 旧 `V2OrderDetail::query()->where('id',$oid)->first()`（金额载体迁移用） */
  async findOrderDetailRow(db: Db, oid: number) {
    return db.v2_order_detail.findUnique({ where: { id: oid } });
  }

  /** 旧 `V2OrderDetail::updateOrCreate([...], $detailData)` + 源行 delete（载体迁移） */
  async moveOrderDetailRow(db: Db, fromOid: number, toOid: number, createdAt: Date): Promise<void> {
    const detail = await db.v2_order_detail.findUnique({ where: { id: fromOid } });
    if (!detail) return;
    const rest: Record<string, unknown> = { ...detail };
    delete rest['id'];
    delete rest['created_at'];
    delete rest['updated_at'];
    // Prisma 的 Json 空值须用 Prisma.JsonNull；「读到的行原样回写」用 as never 收口（值域同构）
    const detailData = { ...rest, updated_at: createdAt } as never;
    const existing = await db.v2_order_detail.findUnique({ where: { id: toOid }, select: { id: true } });
    if (existing) {
      await db.v2_order_detail.update({ where: { id: toOid }, data: detailData });
    } else {
      await db.v2_order_detail.create({ data: { ...(detailData as object), id: toOid, created_at: createdAt, updated_at: createdAt } as never });
    }
    await db.v2_order_detail.delete({ where: { id: fromOid } });
  }

  /**
   * 旧 `BargainRecord::updateOrCreate(['goodid','goodstype'], $record)`。
   * ⚠ 唯一键是 `(goodid, goodstype)` 业务属性键 → ODKU 会跨实体覆盖（记忆头号坑），
   * 此处用「先查后 update/create」保持旧语义（旧代码本身就是 updateOrCreate 的查后写，
   * 并发下同 goodid 的两次回传会互相覆盖——旧系统同样如此，登记 S-new 不修）。
   */
  async upsertBargainRecord(db: Db, record: {
    goodid: string;
    goodstype: number;
    oid: number;
    goodsnum: number;
    goodsamt: number;
    orgprice: number;
    bgprice: number;
    adminname: string;
    adminid: number;
    addtime: number;
  }): Promise<void> {
    const goodid = BigInt(record.goodid || '0');
    const existing = await db.dg_bargain_record.findFirst({
      where: { goodid, goodstype: record.goodstype },
      select: { id: true },
    });
    const data = {
      oid: record.oid,
      goodsnum: record.goodsnum,
      goodsamt: record.goodsamt,
      orgprice: record.orgprice,
      bgprice: record.bgprice,
      adminname: record.adminname,
      adminid: record.adminid,
      addtime: record.addtime,
    };
    if (existing) {
      await db.dg_bargain_record.update({ where: { id: existing.id }, data });
      return;
    }
    await db.dg_bargain_record.create({ data: { ...data, goodid, goodstype: record.goodstype } });
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

  // -----------------------------------------------------------------------
  // 加购链路（旧 AddCartMutation）
  // -----------------------------------------------------------------------

  /**
   * 旧 `Cart::countForUser`：dfflag 分流 type（DF=3 / 普通=[1,2]）后 count。
   * ⚠ 与列表的分流同源但口径独立——行数上限守卫只认这一口径。
   */
  async countUserCarts(db: Db, uid: number, types: number[]): Promise<number> {
    return db.dg_cart.count({ where: { uid, type: { in: types } } });
  }

  /**
   * 旧 `handleSkuDuplication` 的 `Cart::where(uid)->whereIn(goodsid)->get()`。
   * 列集 = 判定所需：gid/goodsid/sku_name/goodsnum + compareExtraFields 的 17 列。
   */
  async listCartsByGoodsIds(db: Db, uid: number, goodsIds: string[]): Promise<Array<{
    gid: number; goodsid: string | null; sku_name: string; goodsnum: number;
    yanhuofba: string; yanhuoasin: string; yanhuofnsku: string; outid: string | null;
    goodsremark: string | null;
    var1: string; var2: string; var3: string; var4: string; var5: string; var6: string;
    var7: string; var8: string | null; var9: string | null; var10: string | null;
    var11: string | null; var12: string | null;
  }>> {
    if (goodsIds.length === 0) return [];
    return db.dg_cart.findMany({
      where: { uid, goodsid: { in: goodsIds } },
      select: {
        gid: true, goodsid: true, sku_name: true, goodsnum: true,
        yanhuofba: true, yanhuoasin: true, yanhuofnsku: true, outid: true,
        goodsremark: true,
        var1: true, var2: true, var3: true, var4: true, var5: true, var6: true,
        var7: true, var8: true, var9: true, var10: true, var11: true, var12: true,
      },
    });
  }

  /**
   * 旧 `Cart::create($cart)`。
   *
   * ⚠ **24 个无默认 NOT NULL 串列必须显式落 `''`**：旧 Eloquent 不传这些列，靠
   * MySQL **非严格模式**自动填 `''`（S25 同族怪癖）；Prisma 要求显式传值，
   * 落 `''` 才是 1:1 等价（落 null 会被 Prisma 拒、落空格才是错）。
   */
  async createCart(db: Db, data: CreateCartData): Promise<{ gid: number }> {
    const filtered: Record<string, unknown> = { ...CART_NO_DEFAULT_EMPTY_COLS };
    for (const [key, value] of Object.entries(data)) {
      // 旧 Eloquent `Cart::create` 有 $fillable 白名单：**未知键静默丢弃**（不报错）。
      // 实例：prepareCarts 会往 $cart 里塞 `miId`（dg_cart 无此列），正是靠 fillable 丢掉的。
      if (value === undefined || !CART_FILLABLE.has(key)) continue;
      filtered[key] = value;
    }
    const row = await db.dg_cart.create({
      data: filtered as LegacyPrisma.dg_cartCreateInput,
      select: { gid: true },
    });
    return { gid: row.gid };
  }

  /** 旧合并模式的 `Cart::whereIn('gid', $duplicatedGids)->delete()`（硬删，无软删） */
  async deleteCarts(db: Db, gids: number[]): Promise<void> {
    if (gids.length === 0) return;
    await db.dg_cart.deleteMany({ where: { gid: { in: gids } } });
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
