import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { envelopeFail, envelopeOk, cartListQuerySchema } from '@crossbuy/contract';
import { authenticate } from '@/server/authenticate';
import { getCartService } from '@/server/order';

/**
 * GET /api/customer/v1/carts —— 购物车列表（旧 listCart 的 REST 化）。
 * dfflag 分流 + ids 过滤 + sku 桶聚拢 + 按卖家分组（服务端完成，1:1）。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;
  const { principal } = auth;

  const parsed = cartListQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(envelopeFail(400, parsed.error.issues[0]?.message ?? '参数错误', traceId), { status: 400 });
  }

  const result = await getCartService().listCarts(principal, parsed.data);
  if (!result.ok) {
    return NextResponse.json(envelopeFail(400, result.error.message, traceId), { status: 400 });
  }
  return NextResponse.json(envelopeOk(result.value, traceId));
}
