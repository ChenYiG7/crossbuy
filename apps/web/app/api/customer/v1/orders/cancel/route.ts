import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  envelopeFail,
  envelopeOk,
  openApiCancelOrderSchema,
} from '@crossbuy/contract';
import { authenticate } from '@/server/authenticate';
import { getOrderService } from '@/server/order';
import { httpStatusForMemberError } from '@/server/http-status';

/**
 * POST /api/customer/v1/orders/cancel —— 用户取消订单（旧 cancelOrder GraphQL 的 REST 化）。
 *
 * 链路（旧 OrderCancelService 1:1）：行锁 user → 行锁 orders（排除软删）→ 守卫
 * （归属 + 1/6 态）→ sendprice 组内转移 → 返金入账（dg_record action=4）→
 * state=10 + bargainprice=0 → 组金额归一化 + 运单/发票同步（同一事务）。
 *
 * orderIds 兼容两种形态（旧接口）：逗号分隔字符串 / 整型数组；归一化 = 正整数去重。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  const parsed = openApiCancelOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(envelopeFail(400, '入参不合法', traceId), { status: 400 });
  }

  const result = await getOrderService().cancelOrders(auth.principal, Array.isArray(parsed.data.orderIds) ? parsed.data.orderIds : parsed.data.orderIds.split(','));
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  return NextResponse.json(envelopeOk({ canceledOrderIds: result.value }, traceId));
}
