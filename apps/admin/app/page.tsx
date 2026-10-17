import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_SESSION_COOKIE_NAME } from '@/auth/cookies';
import { verifyAdminPrincipal } from '@/server/authenticate';

/** 首页 → 用户列表（M1 唯一已接入模块；后续模块随 admin 铺开） */
export default async function HomePage() {
  const cookieStore = await cookies();
  const verified = await verifyAdminPrincipal(cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value);
  if (!verified.ok) {
    redirect('/login');
  }
  redirect('/users');
}
