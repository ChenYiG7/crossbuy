import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { AdminScope } from '@crossbuy/contract';
import { ADMIN_SESSION_COOKIE_NAME } from '@/auth/cookies';
import { verifyAdminPrincipal } from '@/server/authenticate';
import { getAdminService, getMemberService } from '@/server/container';
import { UsersPanel } from './users-panel';

/**
 * /users —— 后台「用户管理」只读列表（docs/06 §四-4，M1）。
 *
 * 数据流（RSC 直调，不过 HTTP）：cookie → AdminTokenVerifier → Principal →
 * adminService.resolveScope（实时 RBAC 判定，1:1 旧 grid `$user->cannot(...)`）→
 * memberService.listForAdmin（dg_users 属 member 域，admin app 跨域装配走接口）。
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const cookieStore = await cookies();
  const verified = await verifyAdminPrincipal(cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value);
  if (!verified.ok) {
    redirect('/login');
  }

  const { q } = await searchParams;
  const adminService = getAdminService();

  const scopeResult = await adminService.resolveScope(Number(verified.value.subject));
  if (!scopeResult.ok) {
    redirect('/login');
  }
  const scope: AdminScope = scopeResult.value;

  const list = await getMemberService().listForAdmin(scope, { q: q?.trim() || undefined, page: 1, limit: 20 });
  if (!list.ok) {
    throw new Error(`用户列表查询失败：${list.error.message}`);
  }

  const scopeLabel =
    scope.kind === 'all'
      ? '全部客户'
      : scope.kind === 'flags'
        ? `仅分组 ${scope.flags.join('/')}（含未分组）`
        : '无可见范围';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 p-8">
      <header className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">淘太郎 · 运营后台</h1>
        <p className="text-sm text-muted-foreground">M1 只读切片：会员列表（新老并行，员工可培训）</p>
      </header>
      <UsersPanel scopeLabel={scopeLabel} scope={scope.kind} initial={list.value} />
    </main>
  );
}
