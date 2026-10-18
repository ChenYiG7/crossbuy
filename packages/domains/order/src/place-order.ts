import { createHash } from 'node:crypto';
import type { Principal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import {
  OrderStatus,
  placeOrderSchema,
  type PlaceOrderInput,
  type PlaceOrderResult,
  type SupplierProductRead,
} from '@crossbuy/contract';

import type { OrderError } from './errors';
import { orderError } from './errors';
import { DF_CONFIGS, DF_FLAG_1, ORDER_FLAGS, ORDER_TYPE, RECORD, UTYPE } from './legacy-constants';
import {
  calculateTierPrices,
  countMoneyWithDeductions,
  type CartMoneyBreakdown,
  type SupplierCatalogPort,
} from './cart';
import { parseSkuName } from './list-helpers';
import type { CartForOrderRow, CreateOrderData, OrderRepository, Tx } from './repository';

/**
 * 下单链路（旧 CreateOrderMutation + CreateOrderFromCartService + Cart::cartToOrder
 * + Order::payOrder 1:1）。dg_cart / dg_order 属主 = order 域——service 落本域。
 *
 * 语义锚点（改一行就会和旧系统 diff，动前先读）：
 * - **购物车装载不过滤 uid/type**（归属守卫在 service；旧 handle() 同）——这是旧系统的
 *   越权面，R1 原样复现（守卫在 ② 立刻拦），R2 才收到装载处。
 * - 阶梯价回写与 sku 归一化跑在**事务外**（旧 refresh/updateTierPrices/normalize 都在
 *   DB::transaction 之前），事务内**重新行锁读一遍**购物车（旧 lockCartsForUpdate）。
 * - `countMoney` 的 `deducted_service_fee` 是**内存态**副作用：写进 cart.extend →
 *   被 cartToOrder 搬进 dg_order.extend → payOrder 再读回来算实付服务费。本文件把这条
 *   隐式链显式化（`deductedByGid` → order.extend → payOrder 入账）。
 * - 一笔购物车行 = 一笔订单 = 一笔扣款流水；余额不足整单失败（事务回滚）。
 */

// ---------------------------------------------------------------------------
// 端口（域间禁横向 import：结构化最小接口，组合根用对方 service / 基础设施装配）
// ---------------------------------------------------------------------------

/**
 * 下单前实时价刷新（旧 RefreshOrderGoodsPricesService）。
 * R1 SDK（淘宝/1688 商品详情）未迁移 → 组合根给 no-op；迁移后仅换实现。
 */
export interface GoodsPriceRefreshPort {
  refresh(carts: CartForOrderRow[]): Promise<void>;
}

/**
 * 1688 规格翻译（旧 Alibaba::getItemDetailFromFenxiaoApi 的 skuAttributes）。
 * R1 SDK 未迁移 → 恒 null（= 旧「获取失败」分支，跳过归一化，不阻断下单）。
 */
export interface SkuTranslationPort {
  attributesFor(
    goodsId: string,
    skuId: string,
  ): Promise<Array<{ name: string; value: string }> | null>;
}

/** 旧 UserBenefitService::previewFeeDeduct 出参（benefit_id 非空才核销） */
export interface FeeDeductPreview {
  canDeduct: number;
  maxDeduct: number;
  benefitId?: number | null;
}

/** 权益端口（旧 UserBenefitService；benefit 域 R1 未迁移 → 恒 null / no-op） */
export interface PlaceOrderBenefitPort {
  previewFeeDeduct(uid: number, originalServerMoney: number): Promise<FeeDeductPreview | null>;
  /** 旧 useFeeDeductBenefit（核销抵扣权益；仅在有 benefit_id 时调） */
  useFeeDeductBenefit(uid: number, originalServerMoney: number, orderIds: number[]): Promise<void>;
}

/**
 * 重复下单闸门（旧 Cache::has / Cache::put / Cache::lock，键见 skuLockSuffix）。
 * R1 组合根给**进程内**实现（单实例正确）；多实例部署前必须换 Redis 实现（TODO(#16)）。
 */
export interface ProcessLockPort {
  has(key: string): Promise<boolean>;
  put(key: string, ttlSeconds: number): Promise<void>;
  /** 取锁失败 = false（旧 `$lock->get()` 失败抛 sku_creating） */
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

/** 事务后副作用端口（Job / 邮件 / MNS；旧 dispatch 在事务内，本域改为 AFTER_COMMIT） */
export interface PlaceOrderSideEffectPort {
  /** 旧 ProcessCreateEmail::dispatch（MAIL_TYPE_CART_TO_ORDER） */
  enqueueCartToOrderEmail(input: {
    uid: number;
    flag: number | null;
    total: number;
  }): Promise<void>;
  /** 旧 MnsMessageService::enqueueOrderCreated */
  enqueueOrderCreated(input: {
    uid: number;
    orderIds: number[];
    money: CartMoneyBreakdown;
  }): Promise<void>;
  /** 旧 ProcessCompletionGoodsInfo::dispatch（1688/淘宝 且 缺图或缺店铺名） */
  enqueueCompletionGoodsInfo(oid: number): Promise<void>;
  /** 旧 ProcessTranslateOrderGoodsInfo::dispatch（每单必投） */
  enqueueTranslateOrderGoodsInfo(oid: number): Promise<void>;
}

/**
 * 一件代发运单端口（dg_sendorder 属主 = send-order 域；R1 在下单事务内同步调用，
 * 与旧 `SendOrder::create` 同事务语义；R3 拆库时改为跨域端口 + 事务消息）。
 */
export interface DaifaSendOrderPort {
  createForDaifa(
    input: {
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
    },
    tx?: Tx,
  ): Promise<{ sid: number }>;
  updateSendOrderOids(sid: number, oids: number[], tx?: Tx): Promise<void>;
}

export interface PlaceOrderDeps {
  repository: OrderRepository;
  runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** 供应商目录只读（v2_supplier_product / v2_supplier_shop 属主 = purchase 域；跨域经端口，TODO #17） */
  supplierCatalog: SupplierCatalogPort;
  /** 阶梯价/金额需要的供应商商品（products 由调用方一次性取，事务内复用） */
  goodsPriceRefreshPort: GoodsPriceRefreshPort;
  skuTranslationPort: SkuTranslationPort;
  benefitPort: PlaceOrderBenefitPort;
  lockPort: ProcessLockPort;
  sideEffects: PlaceOrderSideEffectPort;
  sendOrderPort: DaifaSendOrderPort;
  /** 旧 config('benefit.fee_deduct_preview_switch') !== null（组合根读 env，域内禁直读） */
  feeDeductPreviewEnabled: boolean;
  /** 旧 User::UTYPE_CHARGED */
  utypeCharged: number;
  /** SKU 冷却秒（旧 SKU_COOLDOWN_SECONDS = 30） */
  skuCooldownSeconds: number;
  /** 进程锁秒（旧 PROCESS_LOCK_SECONDS = 300） */
  processLockSeconds: number;
  /** 注入时钟（默认真实时间） */
  clock?: () => Date;
}

/** 旧 lang('order_id')（custom-trans.php:157） */
const LANG_ORDER_ID = 'オーダーID:';
/** 旧 Order::TYPE_1688 / TYPE_TAOBAO（goodssite 列） */
const GOODS_SITE_1688 = '1688';
const GOODS_SITE_TAOBAO = '淘宝';
/** 代购服务费率（旧 0.05） */
const DG_SERVICE_FEE_RATE = 0.05;
/** 旧 SendOrder::STATE_WAITING */
const SEND_ORDER_STATE_WAITING = 1;
/** 旧 DgArrival::STATE_SEND / TYPE_SHOP_DELIVERY */
const ARRIVAL_STATE_SEND = 1;
const ARRIVAL_TYPE_SHOP_DELIVERY = 1;

/** PHP round(x, 2)（金额恒正，HALF_UP 等价） */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function nowSec(clock: () => Date): number {
  return Math.floor(clock().getTime() / 1000);
}

/** 旧 strtotime('today')（生产 PHP 时区 Asia/Shanghai） */
function todayStartSec(now: Date): number {
  const jst = new Date(now.getTime() + 8 * 3600 * 1000);
  const utcMidnight = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
  return Math.floor(utcMidnight / 1000) - 8 * 3600;
}

/** md5（旧 PHP md5；仅用于锁键，不涉安全） */
function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/**
 * 旧 charCv（Helpers.php:382）——老系统迁移的商品名/店铺名兼容清洗，顺序敏感。
 * 注意末尾三行：\t → 空格实体、\r 删除、三空格 → ` &nbsp; `。
 */
export function charCv(msg: string): string {
  let v = msg;
  const pairs: Array<[string, string]> = [
    ['%20', ''],
    ['%27', ''],
    ['*', ''],
    ['"', ''],
    ['&amp;', '&'],
    ['&nbsp;', ' '],
    [';', ''],
    ['"', '&quot;'],
    ["'", '&#039;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    ['(', ''],
    [')', ''],
    ['{', ''],
    ['}', ''],
    ['\t', '   &nbsp;  &nbsp;'],
    ['\r', ''],
    ['   ', ' &nbsp; '],
  ];
  for (const [from, to] of pairs) v = v.split(from).join(to);
  return v;
}

/** 旧 toolsRemoveBlank（Helpers.php:132）——&nbsp; 删除 + \u00A0 → 空格 + trim */
export function toolsRemoveBlank(str: string): string {
  return str.split('&nbsp;').join('').split('\u00A0').join(' ').trim();
}

/** 旧 containsJapanese（平假名/片假名） */
function containsJapanese(text: string): boolean {
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(text);
}

/** 旧 buildSkuNameFromProps（空名/空值跳过；HTML 标签串 1:1） */
function buildSkuNameFromProps(props: Array<{ name: string; value: string }>): string {
  let skuName = '';
  for (const prop of props) {
    if (!prop.name || !prop.value) continue;
    skuName += `<font color=red>${prop.name}:</font><font color=green> ${prop.value} </font>`;
  }
  return skuName;
}

/**
 * 旧 skuLockSuffix：`shangpin_sku` 优先，空则 md5(去空白的 sku_name)；
 * 最终 `uid_md5(goodsid|skuId)`。
 */
export function skuLockSuffix(
  uid: number,
  cart: Pick<CartForOrderRow, 'goodsid' | 'shangpin_sku' | 'sku_name'>,
): string {
  let skuId = (cart.shangpin_sku ?? '').trim();
  if (skuId === '') {
    const normalized = (cart.sku_name ?? '').replace(/\s|&nbsp;/g, '');
    skuId = md5(normalized);
  }
  return `${uid}_${md5(`${cart.goodsid ?? ''}|${skuId}`)}`;
}

/** 旧 batchProcessLockKey：gid 去重升序逗号串的 md5 */
export function batchProcessLockKey(uid: number, gids: Array<number>): string {
  const normalized = [...new Set(gids.map((v) => Math.trunc(v)))].sort((a, b) => a - b).join(',');
  return `create_order_batch_${uid}_${md5(normalized)}`;
}

/** 建单入参（旧 Cart::cartToOrder 的 `$cart->toArray()` + 覆盖项） */
interface CartToOrderContext {
  storeMode: number;
  /** 运单号（无 = ''） */
  sid: string;
  /** 下单会员（旧 `$cart->user`） */
  user: { memberid: string | null; belongCompany: string | null };
  /** 本行抵扣的服务费（旧 countMoney 写进 cart.extend 的内存态值） */
  deductedServiceFee: number | null;
  addtimeSec: number;
  /** 供应商商品读模型（事务外经 purchase 端口取，TODO #17 方案①） */
  products: Map<number, SupplierProductRead>;
  /** 供应商店铺读模型（title/nickname；事务外经端口取） */
  shopMap: Map<number, { title: string; nickname: string | null }>;
}

export class PlaceOrderService {
  constructor(protected readonly deps: PlaceOrderDeps) {}

  /**
   * 购物车转订单（旧 CreateOrderFromCartService::handle 1:1）。
   *
   * 顺序即语义：装载 → 归属/类型守卫 → SKU 冷却 → 进程锁 →（事务外）实时价刷新 →
   * 阶梯价回写 → sku 归一化 →（事务内）行锁重读 → 权益预览 → 金额 → 余额守卫 →
   * 一件代发运单 → 逐行建单扣款删车 →（事务后）Job/邮件/MNS。
   */
  async placeOrders(
    principal: Principal,
    raw: unknown,
  ): Promise<Result<PlaceOrderResult, OrderError>> {
    if (principal.kind !== 'member') return err(orderError('NO_PERMISSIONS'));
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) return err(orderError('NO_PERMISSIONS'));

    const parsed = placeOrderSchema.safeParse(raw);
    if (!parsed.success) return err(orderError('ORDER_PLACE_INPUT_INVALID'));
    const input: PlaceOrderInput = parsed.data;

    const clock = this.deps.clock ?? (() => new Date());
    const db = this.deps.repository.db;

    // ① 装载（旧 `explode(',', $args['ids'])`；非数字 gid 旧 MySQL 隐式转 0 匹配不到行——
    //    这里直接过滤，等价且不让 Prisma 抛类型错）
    const gids = [
      ...new Set(
        input.ids
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((v) => Number.isInteger(v) && v > 0),
      ),
    ];
    const carts = await this.deps.repository.listCartsForOrder(db, gids);
    if (carts.length === 0) return err(orderError('CART_NOT_FOUND'));

    // ② 归属 + 类型守卫（顺序 1:1）
    if (carts.some((c) => c.uid !== uid)) return err(orderError('NO_PERMISSIONS'));
    const types = new Set(carts.map((c) => c.type));
    if (types.size > 1 && carts.some((c) => c.type === ORDER_TYPE.DAIFA)) {
      return err(orderError('ORDER_TYPE_MIXED'));
    }

    // ③ SKU 冷却 → ④ 进程锁（失败则整批释放）
    for (const cart of carts) {
      if (await this.deps.lockPort.has(`create_order_cooldown_${skuLockSuffix(uid, cart)}`)) {
        return err(orderError('ORDER_SKU_CREATING'));
      }
    }
    const lockKeys = [
      batchProcessLockKey(
        uid,
        carts.map((c) => c.gid),
      ),
      ...[
        ...new Set(carts.map((c) => `create_order_process_${skuLockSuffix(uid, cartKeyOf(c))}`)),
      ].sort(),
    ];
    const held: string[] = [];
    for (const key of lockKeys) {
      const got = await this.deps.lockPort.acquire(key, this.deps.processLockSeconds);
      if (!got) {
        for (const k of held) await this.deps.lockPort.release(k);
        return err(orderError('ORDER_SKU_CREATING'));
      }
      held.push(key);
    }

    try {
      const placed = await this.placeOrdersFromCarts(uid, carts, input, clock);

      // 旧 putSkuCooldowns（成功后落冷却，30s 内同规格禁止再下单）
      for (const cart of carts) {
        await this.deps.lockPort.put(
          `create_order_cooldown_${skuLockSuffix(uid, cart)}`,
          this.deps.skuCooldownSeconds,
        );
      }

      // 事务后副作用（旧 dispatch 在事务内——回滚仍会投递；本域按铁律 7 移出事务，见 S33）
      await this.deps.sideEffects.enqueueCartToOrderEmail(placed.mail);
      await this.deps.sideEffects.enqueueOrderCreated({
        uid,
        orderIds: placed.orderIds,
        money: placed.money,
      });
      for (const oid of placed.completionOids)
        await this.deps.sideEffects.enqueueCompletionGoodsInfo(oid);
      for (const oid of placed.orderIds)
        await this.deps.sideEffects.enqueueTranslateOrderGoodsInfo(oid);

      return ok({
        orderIds: placed.orderIds,
        totalMoney: placed.money.totalMoney.toFixed(2),
        sendOrderId: placed.sendOrderId,
      });
    } catch (e) {
      // 旧 UserError → GraphQL 异常；新系统 Result 化（可预期业务失败不上抛）
      if (isOrderError(e)) return err(e);
      throw e;
    } finally {
      for (const k of held) await this.deps.lockPort.release(k);
    }
  }

  /** 旧 placeOrdersFromCarts（事务外预处理 + 事务内建单） */
  private async placeOrdersFromCarts(
    uid: number,
    carts: CartForOrderRow[],
    input: PlaceOrderInput,
    clock: () => Date,
  ): Promise<{
    orderIds: number[];
    money: CartMoneyBreakdown;
    sendOrderId: number | null;
    completionOids: number[];
    mail: { uid: number; flag: number | null; total: number };
  }> {
    const db = this.deps.repository.db;
    // 供应商商品（阶梯价/混批/金额所需）经 purchase 域端口读取，事务外一次性取（TODO #17 方案①）
    const products = await this.deps.supplierCatalog.listProductsByIds(
      carts.map((c) => c.supplier_product_id).filter((v): v is number => v !== null),
    );
    // 卖家名（v2_supplier_shop.title/nickname）同样事务外经端口读取——参考数据，与购物车行锁无一致性要求。
    // shop_id 已在 products 内（旧事务内的 supplier_product 读被消除：下单路径 355 已取过，冗余）。
    const shopIds = [
      ...new Set(
        [...products.values()]
          .map((p) => p.shop_id)
          .filter((v): v is number => v !== null && v !== 0),
      ),
    ];
    const shopMap = await this.deps.supplierCatalog.listShopsByIds(shopIds);

    // ⑤ 实时价刷新（旧 RefreshOrderGoodsPricesService；R1 SDK 未迁移 → no-op）
    await this.deps.goodsPriceRefreshPort.refresh(carts);

    // ⑥ 阶梯价回写（旧 updateTierPricesForCarts：仅 1688 + 有 supplier_product_id）
    const tierPrices = calculateTierPrices(carts, products);
    for (const cart of carts) {
      if (cart.goodssite !== GOODS_SITE_1688 || !cart.supplier_product_id) continue;
      const tierPrice = tierPrices.get(cart.gid) ?? cart.goodsprice;
      if (tierPrice !== cart.goodsprice) {
        await this.deps.repository.updateCartGoodsprice(db, cart.gid, tierPrice);
        cart.goodsprice = tierPrice;
      }
    }

    // ⑦ sku 归一化（旧 normalizeCartSkuNamesForOrder；失败只留痕，不阻断）
    await this.normalizeCartSkuNames(carts);

    const storeMode = Math.trunc(input.storeMode ?? 0);
    const completionOids: number[] = [];

    const placed = await this.deps.runTx(async (tx) => {
      // ⑧ 事务内行锁重读（旧 lockCartsForUpdate：数量不符 = cart.not_found）
      const locked = await this.deps.repository.lockCartsForUpdate(
        tx,
        uid,
        carts.map((c) => c.gid),
      );
      if (locked.length !== new Set(carts.map((c) => c.gid)).size) {
        throw orderError('CART_NOT_FOUND');
      }
      const user = await this.deps.repository.lockUserForOrder(tx, uid);
      if (!user) throw orderError('NO_PERMISSIONS');

      const isDaigou = locked[0]?.type === ORDER_TYPE.DAIGOU;

      // ⑨ 权益抵扣预览（旧：代购 + 非付费会员 + 开关非空）
      let feeDeductPreview: FeeDeductPreview | null = null;
      if (isDaigou && user.utype !== this.deps.utypeCharged && this.deps.feeDeductPreviewEnabled) {
        const lockedTierPrices = calculateTierPrices(locked, products);
        let originalServerMoney = 0;
        for (const cart of locked) {
          const unitPrice = lockedTierPrices.get(cart.gid) ?? cart.goodsprice;
          originalServerMoney += unitPrice * (cart.goodsnum ?? 0) * DG_SERVICE_FEE_RATE;
        }
        feeDeductPreview = await this.deps.benefitPort.previewFeeDeduct(uid, originalServerMoney);
      }

      // ⑩ 金额（旧 Cart::countMoney）
      const { money, deductedByGid } = countMoneyWithDeductions(
        locked,
        products,
        user.utype === this.deps.utypeCharged,
        Number(user.dffee ?? 0),
        feeDeductPreview,
      );

      // ⑪ 余额守卫（旧 UserErrorWithCode::USER_INSUFFICIENT_BALANCE）
      if (Number(user.money) < money.totalMoney) {
        throw orderError('ORDER_INSUFFICIENT_BALANCE');
      }

      // ⑫ 一件代发：回写发件信息 + 有收件人则建运单
      let sendOrderId: number | null = null;
      let sid = '';
      if (storeMode === 0 && Number(user.dfflag) === DF_FLAG_1) {
        const dfsendaddress = input.sendAddress ?? '';
        const dfsendtel = input.sendTel ?? '';
        const dfsendname = input.sendName ?? '';
        await this.deps.repository.updateDfSendInfo(tx, uid, {
          dfsendaddress,
          dfsendtel,
          dfsendname,
        });

        if (input.consignee) {
          const sendOrder = await this.deps.sendOrderPort.createForDaifa(
            {
              uid,
              uname: user.uname,
              memberid: user.memberid,
              email: user.email,
              dfsendaddress,
              dfsendname,
              dfsendtel,
              receiver: {
                consignee: input.consignee ?? null,
                address: input.address ?? null,
                tel: input.tel ?? null,
                zip: input.zip ?? null,
                remark: input.remark ?? null,
                country: input.country ?? null,
                deliveryname: input.deliveryname ?? null,
              },
            },
            tx,
          );
          sendOrderId = sendOrder.sid;
          sid = String(sendOrder.sid);
        }
      }

      // ⑬ 逐行建单 → 支付 → 删车
      const addtimeSec = nowSec(clock);
      const orderIds: number[] = [];
      let balance = Number(user.money);
      for (const cart of locked) {
        const data = await this.buildOrderData(tx, cart, {
          storeMode,
          sid,
          user: { memberid: user.memberid, belongCompany: belongCompanyOf(user.belong_company) },
          deductedServiceFee: deductedByGid.get(cart.gid) ?? null,
          addtimeSec,
          products,
          shopMap,
        });
        const order = await this.deps.repository.createOrder(tx, data);

        // 旧 ProcessCompletionGoodsInfo 触发条件（1688/淘宝 且 缺图或缺店铺名）
        const sellerEmpty = !order.goodsseller || order.goodsseller === '';
        if (
          (order.goodssite === GOODS_SITE_1688 || order.goodssite === GOODS_SITE_TAOBAO) &&
          (!order.goodsimg || order.goodsimg === '' || sellerEmpty)
        ) {
          completionOids.push(order.oid);
        }

        // 旧 updateLogisticDomesticForTransshipment（转运 + 有单号）
        if (
          order.type === ORDER_TYPE.ZHUANYUN &&
          order.expressno &&
          order.expressno.trim() !== ''
        ) {
          await this.syncArrivalForTransshipment(tx, order.oid, order.expressno, clock);
        }

        balance = await this.payOrder(tx, order, user, balance, clock);
        await this.deps.repository.deleteCart(tx, cart.gid);
        orderIds.push(order.oid);
      }

      // ⑭ 核销抵扣权益（旧 useFeeDeductBenefit）+ 回写运单 oids
      if (feeDeductPreview && feeDeductPreview.benefitId) {
        await this.deps.benefitPort.useFeeDeductBenefit(uid, money.originalServerMoney, orderIds);
      }
      if (sendOrderId !== null) {
        await this.deps.sendOrderPort.updateSendOrderOids(sendOrderId, orderIds, tx);
      }

      return {
        orderIds,
        money,
        sendOrderId,
        mail: { uid, flag: user.dfflag, total: money.totalMoney },
      };
    });

    return { ...placed, completionOids };
  }

  /**
   * 旧 Cart::cartToOrder（`$cart->toArray()` 搬运 + 覆盖项）。
   * 注意：dg_cart 有而 dg_order 没有的列（goods_name_trans / min_order_quantity /
   * offer_price / retail_price / one_piece_price 等）被旧 Order::$fillable 过滤掉——
   * 这里直接不映射（同效果）。
   */
  private async buildOrderData(
    tx: Tx,
    cart: LockedCartRow,
    ctx: CartToOrderContext,
  ): Promise<CreateOrderData> {
    const type = cart.type ?? 0;
    // 卖家名：事务外经 purchase 端口取的店铺 title ?: nickname，回退购物车原 goodsseller（TODO #17 方案①）
    const shopId = cart.supplier_product_id
      ? (ctx.products.get(cart.supplier_product_id)?.shop_id ?? null)
      : null;
    const shop = shopId !== null ? ctx.shopMap.get(shopId) : undefined;
    const goodsSeller = (shop?.title || shop?.nickname || cart.goodsseller) ?? '';

    // 旧砍价判定：goodsid 非空 → goodstype = 1688 ? 1 : 0
    let agobgflag: number | undefined;
    let agobginfo: string | null | undefined;
    if (cart.goodsid && cart.goodsid !== '') {
      const goodsType = cart.goodssite === GOODS_SITE_1688 ? 1 : 0;
      const bargain = await this.deps.repository.findBargain(
        tx,
        toolsRemoveBlank(cart.goodsid),
        goodsType,
      );
      if (bargain) {
        agobgflag = 1;
        agobginfo = bargain.bgprice === null ? null : String(bargain.bgprice);
      }
    }

    // 旧 state：转运 = 3（无单号 → 2）；其余 = 1
    let state: number = OrderStatus.WAIT_CREATE;
    if (type === ORDER_TYPE.ZHUANYUN) {
      state = cart.expressno && cart.expressno.trim() !== '' ? OrderStatus.SEND : OrderStatus.PAID;
    }

    const extendJson =
      ctx.deductedServiceFee === null
        ? undefined
        : JSON.stringify({ deducted_service_fee: ctx.deductedServiceFee });

    return {
      uid: cart.uid,
      uname: cart.uname ?? '',
      memberid: ctx.user.memberid ?? '',
      belong_company: ctx.user.belongCompany ?? '',
      tid: cart.tid ?? '',
      goodsurl: cart.goodsurl,
      goodsname: charCv(cart.goodsname),
      goodsprice: cart.goodsprice,
      // 非转运订单运费一律归零（旧 cartToOrder）
      sendprice: type === ORDER_TYPE.ZHUANYUN ? cart.sendprice : 0,
      goodsnum: cart.goodsnum,
      goodsimg: cart.goodsimg,
      goodssize: cart.goodssize,
      goodscolor: cart.goodscolor,
      goodsseller: charCv(goodsSeller),
      supplier_shop_id: shopId ?? undefined,
      supplier_product_id: cart.supplier_product_id ?? undefined,
      sellerurl: cart.sellerurl,
      goodssite: cart.goodssite,
      siteurl: cart.siteurl ?? '',
      expressno: cart.expressno ?? '',
      type,
      goodsremark: cart.goodsremark,
      goodsid: cart.goodsid ? toolsRemoveBlank(cart.goodsid) : cart.goodsid,
      proprice: cart.proprice ? round2(Number(cart.proprice)) : 0,
      TermQty: cart.TermQty,
      TermPrice: cart.TermPrice,
      TermShipping: cart.TermShipping,
      inspection: cart.inspection,
      ship: cart.ship,
      // 旧 str_replace("'", "\'", $order['sku_name'])
      sku_name: (cart.sku_name ?? '').split("'").join("\\'"),
      yanhuofba: cart.yanhuofba,
      yanhuojinyun: cart.yanhuojinyun,
      yanhuozengzhi: cart.yanhuozengzhi,
      yanhuoasin: cart.yanhuoasin,
      yanhuofnsku: cart.yanhuofnsku,
      baozhuang: cart.baozhuang,
      hbbaozhuang: cart.hbbaozhuang,
      baonum: cart.baonum,
      SKU: cart.SKU,
      FNSKU: cart.FNSKU,
      shangpin_sku: cart.shangpin_sku,
      shangpin_fnsku: cart.shangpin_fnsku,
      name: cart.name,
      shangpin_name: cart.shangpin_name,
      shangpin_amazon: cart.shangpin_amazon,
      amazon: cart.amazon,
      putong: cart.putong,
      fuzhuang: cart.fuzhuang,
      tiebiao: cart.tiebiao,
      huanbaoz: cart.huanbaoz,
      qita: cart.qita,
      outid: cart.outid ?? '',
      add_from: cart.add_from ? cart.add_from : 1,
      add_from_memo: cart.add_from_memo,
      var1: cart.var1,
      var2: cart.var2,
      var3: cart.var3,
      var4: cart.var4,
      var5: cart.var5,
      var6: cart.var6,
      var7: cart.var7,
      var8: cart.var8,
      var9: cart.var9,
      var10: cart.var10,
      var11: cart.var11,
      var12: cart.var12,
      state,
      addtime: ctx.addtimeSec,
      ...(ctx.sid !== '' ? { sid: ctx.sid } : {}),
      ...(type === ORDER_TYPE.DAIFA ? { dfstoremode: ctx.storeMode } : {}),
      ...(agobgflag !== undefined ? { agobgflag, agobginfo: agobginfo ?? null } : {}),
      ...(extendJson !== undefined ? { extend: extendJson } : {}),
    };
  }

  /** 旧 updateLogisticDomesticForTransshipment（DgArrival firstOrCreate + pivot 关联） */
  private async syncArrivalForTransshipment(
    tx: Tx,
    oid: number,
    expressno: string,
    clock: () => Date,
  ): Promise<void> {
    const expressNos = expressno
      .trim()
      .split(' ')
      .filter((v) => v !== '');
    for (const no of expressNos) {
      const arrival = await this.deps.repository.firstOrCreateArrival(tx, {
        expressno: no,
        providerCode: '', // 旧：转运订单默认无物流商编码
        state: ARRIVAL_STATE_SEND,
        type: ARRIVAL_TYPE_SHOP_DELIVERY,
      });
      await this.deps.repository.attachArrivalOrder(tx, arrival.id, oid, nowSec(clock));
    }
  }

  /**
   * 旧 Order::payOrder（代购/代发两分支扣款；转运不扣款）。
   * @param balance 动账**前**余额（旧每单 `$cart->user` 懒加载重读 = 上一单扣完的余额）
   * @returns 动账后余额
   */
  private async payOrder(
    tx: Tx,
    order: {
      oid: number;
      goodsurl: string | null;
      goodsname: string;
      goodssite: string | null;
      type: number | null;
      goodsprice: number;
      goodsnum: number | null;
      extend: string | null;
    },
    user: {
      uid: number;
      uname: string;
      dfflag: number | null;
      utype: number | null;
      validity: number;
      dffee: number | null;
    },
    balance: number,
    clock: () => Date,
  ): Promise<number> {
    const type = order.type ?? 0;
    const goodsNum = order.goodsnum ?? 0;
    const goodsprice = Number(order.goodsprice);
    const userCharged =
      user.validity >= todayStartSec(clock()) && user.utype === this.deps.utypeCharged;

    let tempmoney: number;
    let ordflag: number;
    let extendJson: string;
    let note: string;

    if (type === ORDER_TYPE.DAIGOU) {
      if (userCharged) {
        tempmoney = goodsprice * goodsNum;
      } else {
        const goodsTotal = goodsprice * goodsNum;
        const serviceCharge = Math.ceil(goodsTotal * DG_SERVICE_FEE_RATE * 100) / 100;
        const deductedServiceFee = readDeductedServiceFee(order.extend);
        const actualServiceCharge = Math.max(0, round2(serviceCharge - deductedServiceFee));
        tempmoney = round2(goodsTotal + actualServiceCharge);
      }
      const goodsLink = `<a href=\\'${order.goodsurl}\\' target=\\'_blank\\'>《${charCv(order.goodsname)}》</a>`;
      note = `${goodsLink} ${LANG_ORDER_ID}${order.oid}, num:${goodsNum}, price:${order.goodsprice}`;
      ordflag = ORDER_FLAGS.DG;
      extendJson = order.extend ?? '[]';
    } else if (type === ORDER_TYPE.DAIFA) {
      if (userCharged) {
        tempmoney = goodsprice * goodsNum;
      } else if (DF_CONFIGS.ISAMTLIMIT === 1 && goodsprice > DF_CONFIGS.AMTLIMIT) {
        tempmoney = goodsprice * goodsNum * DF_CONFIGS.AMTLIMITFEE;
      } else {
        tempmoney = (goodsprice + Number(user.dffee ?? 0)) * goodsNum;
      }
      const goodsLink = `<a href=\\'${order.goodsurl}\\' target=\\'_blank\\'>《${charCv(order.goodsname)}》</a>`;
      note = `<span lang="JA">直送 </span>${goodsLink} ${LANG_ORDER_ID}${order.oid}, num:${goodsNum}, price:${order.goodsprice}`;
      ordflag = ORDER_FLAGS.DF;
      extendJson = '[]'; // 旧代发分支不传 extend → json_encode([])
    } else {
      return balance; // 转运订单 payOrder 不做任何事
    }

    const amount = -tempmoney;
    await this.deps.repository.addBalanceRecord(tx, {
      uid: user.uid,
      uname: user.uname,
      amount,
      action: RECORD.ACTION_1,
      remark: note,
      sn: '',
      oid: order.oid,
      ordflag,
      extendJson,
      nowSec: nowSec(clock),
      balanceBefore: balance,
      dfflag: user.dfflag,
    });
    return balance + amount;
  }

  /**
   * 旧 normalizeCartSkuNamesForOrder：1688 且 sku_name 含日文 → 用平台规格表重建。
   * R1 SDK 未迁移（端口恒 null）→ 恒走「未获取到映射」分支（只留痕，不改数据）。
   */
  private async normalizeCartSkuNames(carts: CartForOrderRow[]): Promise<void> {
    for (const cart of carts) {
      if (cart.goodssite !== GOODS_SITE_1688) continue;
      if (!cart.goodsid || cart.goodsid === '') continue;
      const props = parseSkuName(cart.sku_name ?? '', cart.goodssize, cart.goodscolor);
      if (props.length === 0) continue;
      if (!props.some((p) => containsJapanese(p.name) || containsJapanese(p.value))) continue;

      const normalized = await this.deps.skuTranslationPort.attributesFor(
        cart.goodsid,
        cart.shangpin_sku ?? '',
      );
      if (!normalized || normalized.length === 0) continue;
      const skuName = buildSkuNameFromProps(normalized);
      if (skuName === '') continue;
      cart.sku_name = skuName;
    }
  }
}

/** 事务内行锁后的购物车行（含店铺名解析结果） */
type LockedCartRow = Awaited<ReturnType<OrderRepository['lockCartsForUpdate']>>[number];

/** 锁键用购物车行（结构化取子集，避免把整行传进纯函数） */
function cartKeyOf(
  c: CartForOrderRow,
): Pick<CartForOrderRow, 'goodsid' | 'shangpin_sku' | 'sku_name'> {
  return { goodsid: c.goodsid, shangpin_sku: c.shangpin_sku, sku_name: c.sku_name };
}

/** 旧 User::getBelongCompany（值不在枚举内 → null；dg_order.belong_company NOT NULL → 落 ''） */
function belongCompanyOf(value: string | null): string | null {
  return value === 'HHO' || value === '购霸' ? value : null;
}

/** 旧 getDeductedServiceFee（order.extend 关联数组） */
function readDeductedServiceFee(extend: string | null): number {
  if (!extend) return 0;
  try {
    const parsed: unknown = JSON.parse(extend);
    if (Array.isArray(parsed) || parsed === null || typeof parsed !== 'object') return 0;
    const value = (parsed as Record<string, unknown>)['deducted_service_fee'];
    return typeof value === 'number' ? value : 0;
  } catch {
    return 0;
  }
}

/** 本文件未直接引用但属契约面的再导出（防组合根漏引） */
export type { PlaceOrderInput, PlaceOrderResult };

/** 业务错误判别（service 抛 → 路由 Result 化） */
function isOrderError(e: unknown): e is OrderError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}
