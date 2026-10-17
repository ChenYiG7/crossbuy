import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  envelopeFail,
  envelopeOk,
  orderListQuerySchema,
} from '@crossbuy/contract';
import { getOrderService } from '@/server/order';
import { authenticate } from '@/server/authenticate';
import { httpStatusForMemberError } from '@/server/http-status';

/**
 * GET /api/customer/v1/orders —— 会员订单列表（旧 listOrderV2 的 REST 化）。
 *
 * 查询参数 1:1 旧 OrderListInput（state/states/queryType/keyword/时间窗/mark 标记/
 * 代发在库等 20 项）；`state=3` 自动并入不良待确认（12），行显示态 12→3。
 * 关联视图（sendOrder/examinations/arrival/instantChat）随属主域落地补齐。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;
  const { principal } = auth;

  const parsed = orderListQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(envelopeFail(400, '订单列表参数非法', traceId), { status: 400 });
  }

  const result = await getOrderService().listOrders(principal, parsed.data);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  return NextResponse.json(envelopeOk(result.value, traceId));
}
