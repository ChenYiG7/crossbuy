import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crossbuy/ui';
import { ADMIN_SESSION_COOKIE_NAME } from '@/auth/cookies';
import { verifyAdminPrincipal } from '@/server/authenticate';
import { AdminLoginForm } from './admin-login-form';

/**
 * 后台登录页（M1 §四-4）。已登录 → 重定向首页（不再展示表单）。
 */
export default async function LoginPage() {
  const t = await getTranslations('login');
  const tc = await getTranslations('common');
  const cookieStore = await cookies();
  const verified = await verifyAdminPrincipal(cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value);
  if (verified.ok) {
    redirect('/');
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 p-8">
      <header className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{tc('淘太郎 · 运营后台')}</h1>
        <p className="text-sm text-muted-foreground">{t('登录后进入（替代旧 dcat-admin）')}</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{tc('登录')}</CardTitle>
          <CardDescription>{t('账号密码与旧后台一致（bcrypt 校验）')}</CardDescription>
        </CardHeader>
        <CardContent>
          <AdminLoginForm />
        </CardContent>
      </Card>
    </main>
  );
}
