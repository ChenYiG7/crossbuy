import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  envelopeFail,
  envelopeOk,
  orderListQuerySchema,
} from '@crossbuy/contract';
import { getOrderService, getPlaceOrderService } from '@/server/order';
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

/**
 * POST /api/customer/v1/orders —— 购物车转订单（旧 createOrder GraphQL 的 REST 化）。
 *
 * 链路（旧 CreateOrderFromCartService 1:1）：装载购物车（不过滤 uid/type → 归属守卫在域内）
 * → 类型混装守卫 → SKU 冷却/进程锁 → 阶梯价回写 → 事务内行锁重读 → 权益抵扣预览 →
 * countMoney → 余额守卫 → 一件代发运单 → 逐行建单 + 扣款 + 删车 → 事务后 Job/邮件/MNS。
 *
 * ⚠ 旧 GraphQL 返回字符串 'done'——REST 面改为订单号 + 实付总额 + 运单号（信息不减，
 * 且都是下单后客户端必需的下游入参）。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const result = await getPlaceOrderService().placeOrders(auth.principal, body);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }

  return NextResponse.json(envelopeOk(result.value, traceId));
}
