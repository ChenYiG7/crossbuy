import { cookies } from 'next/headers';
import { getMemberService, getMemberVerifier } from '@/server/member';
import { SESSION_COOKIE_NAME } from '@/auth/cookies';
import { LoginForm } from './login-form';
import { ProfileSection } from './profile-section';
import { FavoritesSection } from './favorites-section';

/**
 * 会员中心页（M1：RSC 直调域服务，不过 HTTP——docs/04 客户面 BFF+RSC 直调）。
 *
 * 未登录/会话失效 → 登录表单；登录成功 → 资料视图 + 收藏列表（默认页签 =
 * 旧 ListFavoriteQuery 二值语义的「非代发含 NULL」，fid 倒序第一页）。
 * 页面读 cookie ⇒ 天然动态渲染（禁静态化）。
 */
export default async function MemberPage() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const verified = token ? await getMemberVerifier().verify(token) : null;

  if (!verified || !verified.ok) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">会员中心</h1>
        </header>
        <p className="text-sm text-muted-foreground">登录后查看会员资料与余额。</p>
        <LoginForm message={verified && !verified.ok ? verified.error.message : undefined} />
      </main>
    );
  }

  const result = await getMemberService().getProfile(verified.value);
  if (!result.ok) {
    // 会话有效但会员已不存在（并发删号）——按未登录处理，带上原因
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-8">
        <header className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">会员中心</h1>
        </header>
        <LoginForm message={result.error.message} />
      </main>
    );
  }

  // 收藏默认页签（不过滤 type = 非代发含 NULL）——域服务直取，不过 HTTP
  const favorites = await getMemberService().listFavorites(verified.value, {});

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">会员中心</h1>
      </header>
      <ProfileSection profile={result.value} />
      {favorites.ok ? (
        <FavoritesSection
          initialItems={favorites.value.items}
          initialTotal={favorites.value.total}
        />
      ) : null}
    </main>
  );
}
