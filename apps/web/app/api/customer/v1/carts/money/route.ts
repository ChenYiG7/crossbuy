import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { envelopeFail, envelopeOk, cartMoneyQuerySchema } from '@crossbuy/contract';
import { authenticate } from '@/server/authenticate';
import { getCartService } from '@/server/order';

/**
 * GET /api/customer/v1/carts/money —— 购物车金额（旧 getCartMoney 的 REST 化）。
 * 阶梯价/混批/服务费抵扣预览/汇率换算全部服务端重算（金额禁信客户端）。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;
  const { principal } = auth;

  const parsed = cartMoneyQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      envelopeFail(400, parsed.error.issues[0]?.message ?? '参数错误', traceId),
      { status: 400 },
    );
  }

  const result = await getCartService().getCartMoney(principal, parsed.data);
  if (!result.ok) {
    return NextResponse.json(envelopeFail(400, result.error.message, traceId), { status: 400 });
  }
  return NextResponse.json(envelopeOk(result.value, traceId));
}
