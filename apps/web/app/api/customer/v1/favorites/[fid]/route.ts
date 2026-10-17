import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { envelopeFail, envelopeOk } from '@crossbuy/contract';
import { getMemberService } from '@/server/member';
import { authenticate } from '@/server/authenticate';
import { httpStatusForMemberError } from '@/server/http-status';

/**
 * DELETE /api/customer/v1/favorites/:fid —— 删除收藏（旧 DeleteFavoriteMutation 的 REST 化）。
 *
 * 旧入参是逗号串多选（fids: "1,2,3"）；REST 面单删，批量由端上循环——行为差异登记
 * docs/plans/08。按 uid 收敛：删别人的 fid 与删不存在的 fid 同为 404 not_found
 * （旧测试 testDeleteFavoriteWithOtherUidFail 锁死该语义）。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fid: string }> },
): Promise<NextResponse> {
  const traceId = randomUUID();

  const auth = await authenticate(request, traceId);
  if (auth instanceof NextResponse) return auth;

  const { fid: fidParam } = await params;
  const fid = Number(fidParam);
  if (!Number.isInteger(fid) || fid <= 0) {
    return NextResponse.json(envelopeFail(400, 'fid 非法', traceId), { status: 400 });
  }

  const result = await getMemberService().deleteFavorite(auth.principal, fid);
  if (!result.ok) {
    const status = httpStatusForMemberError(result.error.code);
    return NextResponse.json(envelopeFail(status, result.error.message, traceId), { status });
  }
  return NextResponse.json(envelopeOk({ fid }, traceId));
}
