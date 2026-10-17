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
  constructor(protected readonly db: LegacyPrismaClient = legacyPrisma) {}

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
}


/** 生产事务运行器（组合根用；域内禁自带连接 → 由此出口提供真事务语义） */
export function runInOrderTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return legacyPrisma.$transaction(fn);
}
