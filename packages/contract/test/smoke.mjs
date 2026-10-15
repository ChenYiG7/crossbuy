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

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
