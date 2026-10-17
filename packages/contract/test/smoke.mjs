/**
 * 冒烟测试：验证契约 schema 运行时行为（词表、开放 API 入参、行视图出参）。
 * 跑法：先 tsc -p tsconfig.json 构建，再 node test/smoke.mjs
 */
import {
  orderStatusSchema, orderTypeSchema, OrderStatus, ORDER_INVALID_STATUSES, ORDER_CANCELABLE_STATUSES,
  openApiCreateOrderSchema, openApiCancelOrderSchema, orderRowSchema, orderStatusChangeSchema,
  sendOrderStatusSchema, SendOrderStatus, prostateCodeSchema,
  paySendOrderSchema, cancelSendOrderSchema, sendOrderRowSchema, sendOrderLabelCreateSchema,
  invoiceReviseRequestSchema, sendOrderSaveSchema, sendOrderStatusChangeSchema,
  DELIVERY_CHANNEL_OBSERVED,
  ORDER_STATUS_TRANSITIONS, ORDER_FINAL_STATUSES, canTransitionOrderStatus,
  SEND_ORDER_STATUS_TRANSITIONS, canTransitionSendOrderStatus,
} from '../dist/index.js';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

check('order status vocab', () => {
  assert(orderStatusSchema.parse(4) === 4, 'parse 4');
  assert(orderStatusSchema.safeParse(13).success === false, 'reject 13');
  assert(ORDER_INVALID_STATUSES.length === 3, 'invalid 3 states');
  assert(ORDER_CANCELABLE_STATUSES.join() === '1,6', 'cancelable 1,6');
  assert(OrderStatus.ARRIVE_CHINA === 4, 'ARRIVE_CHINA=4');
});
check('order type vocab', () => {
  assert(orderTypeSchema.parse(3) === 3, 'parse 3');
  assert(orderTypeSchema.safeParse(4).success === false, 'reject 4');
});
check('open api create order', () => {
  const r = openApiCreateOrderSchema.parse({
    goodsList: [{ platform: 'taobao', title: 'x', url: 'https://item.taobao.com/1', quantity: 2, fba: true }],
  });
  assert(r.goodsList[0].fba === true, 'fba true');
  assert(openApiCreateOrderSchema.safeParse({ goodsList: [] }).success === false, 'reject empty');
  assert(openApiCreateOrderSchema.safeParse({
    goodsList: Array.from({ length: 21 }, (_, i) => ({ platform: '1688', title: `g${i}`, url: 'https://detail.1688.com/1', quantity: 1 })),
  }).success === false, 'reject >20');
});
check('open api cancel order (string|array)', () => {
  const a = openApiCancelOrderSchema.parse({ orderIds: '5371514,5371515' });
  assert(typeof a.orderIds === 'string', 'string form kept');
  const b = openApiCancelOrderSchema.parse({ orderIds: [1, 2] });
  assert(Array.isArray(b.orderIds), 'array form kept');
});
check('order row view', () => {
  const row = orderRowSchema.parse({
    id: 1, groupId: 2, memberId: 3, type: 1, status: 4, statusEnteredAt: '2026-01-01T00:00:00Z',
    source: 'api', creationMode: 'one_click', goodsId: null, goodsUrl: null, goodsName: 'x',
    goodsImg: null, skuName: null, quantity: 1, unitPrice: '10.00', bargainedUnitPrice: '10.00',
    shippingFee: '0.00', serviceFeeOffset: '0.00', sendOrderId: null, domesticTrackingNo: null,
    reissueNo: null, reissueSeq: null, isAfterSale: false, isFavorite: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  assert(row.status === 4, 'status 4');
});
check('order status change', () => {
  const c = orderStatusChangeSchema.parse({ orderId: 1, toStatus: 5, operatorType: 'admin', reason: 'x' });
  assert(c.toStatus === 5, 'toStatus 5');
  assert(orderStatusChangeSchema.safeParse({ orderId: 1, toStatus: 99, operatorType: 'admin' }).success === false, 'reject bad status');
});
check('send order status vocab', () => {
  assert(sendOrderStatusSchema.parse(7) === 7, 'parse 7');
  assert(sendOrderStatusSchema.safeParse(9).success === false, 'reject 9');
  assert(SendOrderStatus.PENDING_PAY === 7, 'PENDING_PAY=7');
});
check('prostate vocab', () => {
  assert(prostateCodeSchema.parse(9) === 9, 'parse 9');
  assert(prostateCodeSchema.safeParse(10).success === false, 'reject 10');
});
check('pay send order', () => {
  const r = paySendOrderSchema.parse({ sid: 123, captcha: '123456' });
  assert(r.sid === 123, 'sid');
  assert(paySendOrderSchema.safeParse({ sid: 1, captcha: '12345' }).success === false, 'reject 5-digit captcha');
  assert(paySendOrderSchema.safeParse({ sid: 0, captcha: '123456' }).success === false, 'reject sid 0');
});
check('cancel send order', () => {
  assert(cancelSendOrderSchema.parse({ sid: 5 }).sid === 5, 'parse');
});
check('label create', () => {
  const r = sendOrderLabelCreateSchema.parse({
    sendOrderId: 1, type: 'fba_box', filePath: 'oss://x', fileName: 'a.pdf', mime: 'application/pdf', size: 100,
    boxes: [{ boxNo: '1', qty: 2 }],
  });
  assert(r.type === 'fba_box', 'type');
  assert(sendOrderLabelCreateSchema.safeParse({
    sendOrderId: 1, type: 'bad_type', filePath: 'p', fileName: 'f', mime: 'm', size: 1,
  }).success === false, 'reject bad type');
});
check('invoice revise request', () => {
  const r = invoiceReviseRequestSchema.parse({
    sendOrderId: 1, invoiceVersion: 'v1', comment: 'x', imagePaths: ['oss://a.png'],
  });
  assert(r.invoiceVersion === 'v1', 'version');
  assert(invoiceReviseRequestSchema.safeParse({ sendOrderId: 1, invoiceVersion: '', comment: 'x' }).success === false, 'reject empty version');
});
check('send order save (importer info)', () => {
  const r = sendOrderSaveSchema.parse({ consignee: 'x', importerInfo: { real_time_account: '1234567890' } });
  assert(r.consignee === 'x', 'consignee');
});
check('send order row view', () => {
  const row = sendOrderRowSchema.parse({
    id: 1, sn: 'CP123', memberId: 2, orderType: 1, status: 2,
    statusEnteredAt: '2026-01-01T00:00:00Z', prostate: null,
    internationalFreight: '100.00', serviceFee: '10.00', customsFee: '5.00',
    remoteFee: '0.00', domesticShippingFee: '20.00', insuranceFee: '0.00',
    chargedTotalFee: '135.00', bargainAmount: '0.00', bargainRefunded: false,
    deliveryChannel: 'ヤマト急便', totalPackages: 2,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  assert(row.status === 2, 'status 2');
  assert(DELIVERY_CHANNEL_OBSERVED.includes('ヤマト急便'), 'observed channel documented');
});
check('send order status change', () => {
  const c = sendOrderStatusChangeSchema.parse({ sendOrderId: 1, toStatus: 3, operatorType: 'system' });
  assert(c.toStatus === 3, 'toStatus 3');
});

// ---------------------------------------------------------------------------
// 状态迁移白名单（docs/plans/09 §1.1 / §2.1 核实正本；2026-10-17 落地）
// ---------------------------------------------------------------------------
check('order transitions: cancel path', () => {
  assert(canTransitionOrderStatus(1, 10) === true, '1→10 user cancel');
  assert(canTransitionOrderStatus(6, 10) === true, '6→10 user cancel');
  assert(canTransitionOrderStatus(2, 10) === false, '2→10 forbidden (admin 无直写 10)');
  assert(canTransitionOrderStatus(5, 10) === false, '5→10 forbidden');
});
check('order transitions: refund split 6→10/11', () => {
  assert(canTransitionOrderStatus(6, 11) === true, '6→11 admin 废弃');
  assert(canTransitionOrderStatus(6, 1) === true, '6→1 回改重新下单');
  assert(canTransitionOrderStatus(10, 11) === false && canTransitionOrderStatus(11, 10) === false, '终态互斥');
  for (const to of ORDER_FINAL_STATUSES) {
    assert(!ORDER_STATUS_TRANSITIONS[to].includes(10) && !ORDER_STATUS_TRANSITIONS[to].includes(11), `终态 ${to} 不可再迁出`);
  }
});
check('order transitions: dead state 8', () => {
  assert(ORDER_STATUS_TRANSITIONS[8].length === 0, '→8 无迁移（S17 死状态）');
  assert(canTransitionOrderStatus(2, 8) === false, 'x→8 forbidden');
  assert(canTransitionOrderStatus(8, 2) === false, '8→x forbidden（8 不在任何 from 表）');
});
check('order transitions: main flow + loops', () => {
  assert(canTransitionOrderStatus(1, 2) && canTransitionOrderStatus(2, 3), '1→2→3');
  assert(canTransitionOrderStatus(3, 4) && canTransitionOrderStatus(4, 5), '3→4→5');
  assert(canTransitionOrderStatus(5, 4) === true, '5→4 取消运单回退');
  assert(canTransitionOrderStatus(5, 5) === true, '5→5 自环重提交');
  assert(canTransitionOrderStatus(12, 9) === true, '12→9 确认售后');
  assert(canTransitionOrderStatus(9, 12) === true, '9→12 打回待确认');
  assert(canTransitionOrderStatus(4, 3) === true, '4→3 admin 编辑（旧无 from 校验，保真）');
  assert(canTransitionOrderStatus(8, 3) === false, '8→x forbidden（8 不在任何 from 表，dump 零行）');
});
check('send order transitions: pay & receive', () => {
  assert(canTransitionSendOrderStatus(7, 8) === true, '7→8 付运费');
  assert(canTransitionSendOrderStatus(1, 8) === false, '1→8 forbidden');
  assert(canTransitionSendOrderStatus(2, 3) === true, '2→3 确认收货');
  assert(canTransitionSendOrderStatus(8, 2) === true, '8→2 邮寄');
  assert(canTransitionSendOrderStatus(3, 2) === true, '3→2 admin 批量邮寄（旧无守卫，保真）');
});
check('send order transitions: dead state 6 & invoice', () => {
  assert(SEND_ORDER_STATUS_TRANSITIONS[6].length === 0, '→6 无迁移（全库无写点）');
  assert(canTransitionSendOrderStatus(1, 7) === true, '1→7 发送发票');
  assert(canTransitionSendOrderStatus(2, 7) === false, '2→7 forbidden（旧禁已邮寄）');
  assert(canTransitionSendOrderStatus(7, 5) === true, '7→5 发票修改退回');
  assert(canTransitionSendOrderStatus(1, 1) === false, '1→1 无自环');
});

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
