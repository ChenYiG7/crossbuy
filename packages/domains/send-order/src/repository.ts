import { legacyPrisma, type LegacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';

/**
 * 运单/合包/发货/发票 域 repository 防腐层（docs/04 §5 / docs/07）。
 *
 * 本文件是 send-order 域唯一允许 import @crossbuy/db 的位置——ESLint 边界规则强制，
 * 全仓其他位置 import 即 lint error（守卫有效性由 scripts/boundary-probe.mjs 破坏验证）。
 *
 * 纪律：
 * - 旧表原样读写，禁顺手清理列名；复现怪癖必须 1:1 并登记 docs/plans/08
 * - 时间戳 Asia/Shanghai 语义；金额读入即转 Decimal（utils/money 单入口）
 * - 别域数据禁直连表：跨域读走属主域 service 接口（docs/04 §3.2-1）
 * - 写路径唯一入口 + 状态机 CAS（UPDATE ... WHERE status=from）随域铺开时落
 * - 属主旧表清单见 docs/plans/07-表属主映射.md
 */
/** 事务句柄（service 透传用；域内禁直 import @crossbuy/db） */
export type SendOrderTx = LegacyPrisma.TransactionClient;

export class SendOrderRepository {
  // db 对域内 service 开放（组装 where 与分页共用连接）；域外仍禁直触
  constructor(public readonly db: LegacyPrismaClient = legacyPrisma) {}

  // -----------------------------------------------------------------------
  // 会员运单列表（旧 SendOrderListInput::buildQuery + ListSendOrderQuery 1:1）
  // -----------------------------------------------------------------------

  /** 列表行（select 子集） */
  async listMemberSendOrders(db: LegacyPrismaClient, where: LegacyWhere, page: number, limit: number) {
    const rows = await db.dg_sendorder.findMany({
      where,
      select: {
        sid: true, uid: true, oids: true, consignee: true, address: true, tel: true, zip: true,
        deliveryname: true, sn: true, countweight: true, dflwh: true, state: true,
        freight: true, serverfee: true, customsfee: true, sendprice: true, remotefee: true,
        comment: true, commenttime: true, reply: true, remark: true, havefapiao: true,
        addtime: true, uptime: true, importer_info: true, enname: true, company_name: true,
        country: true, dfsendname: true, dfsendaddress: true, dfsendtel: true,
        origin_package_choice: true,
      },
      orderBy: { addtime: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return rows;
  }

  /** 国际物流信息（旧 airbills relation select 子集 1:1） */
  async listAirbills(db: LegacyPrismaClient, sid: number) {
    return db.dg_airbill.findMany({
      where: { sendid: sid },
      select: { sendid: true, sn: true, trace_info: true },
    });
  }
  /**
   * 1688 物流建档运单（旧 tryGetOrders 尾段 SendOrder::create 字段 1:1）。
   * dump 必填列（uname/memberid/xiwgfei/xwdj/consignee）显式落；全零金额 1:1。
   */
  async createFor1688Logistics(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    oids: number[];
    receiver: { regionName?: string; detailAddress?: string };
  }, tx?: LegacyPrisma.TransactionClient): Promise<{ sid: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const run = async (client: LegacyPrisma.TransactionClient) => {
      const row = await client.dg_sendorder.create({
        data: {
          uid: input.uid,
          uname: input.uname,
          memberid: input.memberid ?? '',
          email: input.email,
          oids: input.oids.join(','),
          couponid: 0,
          couponmoney: 0,
          serverfee: 0,
          customsfee: 0,
          yishouqufee: 0,
          xiwgfei: 0,
          xwdj: '',
          totalfee: 0,
          countmoney: 0,
          areaname: '',
          addtime: nowSec,
          uptime: nowSec,
          state: 1, // SendOrder::STATE_WAITING
          storage: 0,
          otype: 3, // SendOrder::OTYPE_3「一件代发」
          dfsendaddress: '',
          dfsendname: '',
          dfsendtel: '',
          consignee: '',
          address: input.receiver.detailAddress ?? '',
          tel: '',
          zip: '',
          remark: '',
          country: input.receiver.regionName ?? '',
        },
        select: { sid: true },
      });
      return row.sid;
    };
    // tx 显式透传 / repository 绑定 tx 客户端（无 $transaction）= 调用方持事务边界直跑
    let sid: number;
    if (tx) sid = await run(tx);
    else if (typeof (this.db as { $transaction?: unknown }).$transaction !== 'function') {
      sid = await run(this.db as LegacyPrisma.TransactionClient);
    } else {
      sid = await this.db.$transaction(run);
    }
    return { sid };
  }

  /**
   * 一件代发下单运单（旧 CreateOrderFromCartService::placeOrdersFromCarts 的
   * SendOrder::create($sendOrderData + $receiveInfo) 1:1）。
   *
   * ⚠ 与 1688 物流建档的差异：本路径落**收件人七列**与**代发发件三列**，
   * 且 consignee 非空（旧 `!empty($options['consignee'])` 才建单）。
   */
  async createForDaifa(input: {
    uid: number;
    uname: string;
    memberid: string | null;
    email: string | null;
    dfsendaddress: string;
    dfsendname: string;
    dfsendtel: string;
    receiver: {
      consignee: string | null;
      address: string | null;
      tel: string | null;
      zip: string | null;
      remark: string | null;
      country: string | null;
      deliveryname: string | null;
    };
  }, tx?: SendOrderTx): Promise<{ sid: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const client = tx ?? this.db;
    const row = await client.dg_sendorder.create({
      data: {
        uid: input.uid,
        uname: input.uname,
        memberid: input.memberid ?? '',
        email: input.email,
        oids: '',
        couponid: 0,
        couponmoney: 0,
        serverfee: 0,
        customsfee: 0,
        yishouqufee: 0,
        xiwgfei: 0,
        xwdj: '',
        totalfee: 0,
        countmoney: 0,
        areaname: '',
        addtime: nowSec,
        uptime: nowSec,
        state: 1, // SendOrder::STATE_WAITING
        storage: 0,
        otype: 3, // SendOrder::OTYPE_3「一件代发」
        dfsendaddress: input.dfsendaddress,
        dfsendname: input.dfsendname,
        dfsendtel: input.dfsendtel,
        // 旧 Arr::only($options, [...])：缺失键落 null（列可空 → 原样；consignee 非null → ''）
        consignee: input.receiver.consignee ?? '',
        address: input.receiver.address,
        tel: input.receiver.tel,
        zip: input.receiver.zip,
        remark: input.receiver.remark,
        country: input.receiver.country,
        deliveryname: input.receiver.deliveryname,
      },
      select: { sid: true },
    });
    return { sid: row.sid };
  }

  /** 回写运单 oids（旧 `$sendOrder->oids = implode(',', $orderIds); $sendOrder->save();`） */
  async updateSendOrderOids(sid: number, oids: number[], tx?: SendOrderTx): Promise<void> {
    const client = tx ?? this.db;
    // updateMany（不回读全列，避开本地 dump 缺生产新列的 P2022）
    await client.dg_sendorder.updateMany({ where: { sid }, data: { oids: oids.join(',') } });
  }
}

/** 旧 query builder 的 Prisma where 形态（service 组装用） */
export type LegacyWhere = LegacyPrisma.dg_sendorderWhereInput;
