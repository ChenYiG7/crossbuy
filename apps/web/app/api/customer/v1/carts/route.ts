import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { envelopeFail, envelopeOk, cartListQuerySchema } from '@crossbuy/contract';
import { authenticate } from '@/server/authenticate';
import { getAddCartService, getCartService } from '@/server/order';
import { httpStatusForMemberError } from '@/server/http-status';

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
    return NextResponse.json(
      envelopeFail(400, parsed.error.issues[0]?.message ?? '参数错误', traceId),
      { status: 400 },
    );
  }

  const result = await getCartService().listCarts(principal, parsed.data);
  if (!result.ok) {
    return NextResponse.json(envelopeFail(400, result.error.message, traceId), { status: 400 });
  }
  return NextResponse.json(envelopeOk(result.value, traceId));
}

/**
 * POST /api/customer/v1/carts —— 加购（旧 addCart GraphQL 的 REST 化）。
 *
 * 链路（旧 AddCartMutation 1:1）：isValidate=1 短路 → 预处理（URL 解析 goodsid +
 * SKU HTML）→ 平台实价覆盖 → 最低起订量（开放接口）→ SKU 去重/合并 → 行数上限 →
 * 再买一单校验 → 店铺/商品映射 → 建行 → Job/翻译投递。
 *
 * ⚠ `result` 与旧系统同形（'done' / gid 逗号串 / 再买一单跳转 URL），额外结构化
 * `cartIds` 与 `redirectUrl` 方便客户端分流。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  const result = await getAddCartService().addCarts(auth.principal, body);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }
  return NextResponse.json(envelopeOk(result.value, traceId));
}
