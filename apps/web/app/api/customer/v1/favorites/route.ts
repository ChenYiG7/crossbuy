import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { envelopeFail, envelopeOk, favoriteCreateSchema, type Favorite } from '@crossbuy/contract';
import { getMemberService } from '@/server/member';
import { authenticate } from '@/server/authenticate';
import { httpStatusForMemberError } from '@/server/http-status';

/**
 * POST /api/customer/v1/favorites —— 新增收藏（旧 AddFavoriteMutation 的 REST 化）。
 *
 * 商品快照由客户端传（名/价/链接/图/商家）——域内**不跨域读商品表**
 * （v2_supplier_product 属 purchase 域，docs/04 §3.2-1；将来 product_id 形态的
 * 入口随 purchase 域 service 接口落地，见 TODO #8）。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(envelopeFail(400, '请求体不是合法 JSON', traceId), { status: 400 });
  }

  const parsed = favoriteCreateSchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'body';
    return NextResponse.json(
      envelopeFail(400, `字段 ${field} 校验失败：${parsed.error.issues[0]?.message ?? ''}`, traceId),
      { status: 400 },
    );
  }

  const result = await getMemberService().addFavorite(auth.principal, parsed.data);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }
  return NextResponse.json(envelopeOk(result.value satisfies Favorite, traceId));
}

/**
 * GET /api/customer/v1/favorites?type=&page=&limit= —— 收藏列表
 * （旧 ListFavoriteQuery + FavoriteController：二值 type 过滤 + fid 倒序 + 分页）。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const result = await getMemberService().listFavorites(auth.principal, params);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }
  return NextResponse.json(envelopeOk(result.value, traceId));
}
