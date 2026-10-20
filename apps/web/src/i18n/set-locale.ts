'use server';

import { cookies } from 'next/headers';
import { isLocale, LOCALE_COOKIE } from './config';

/**
 * 语言切换 Server Action：写偏好 cookie。
 * Next 15 cookies() 为 async；写 cookie 只允许在 Server Action / Route Handler，
 * Action 完成后当前路由树自动重渲染，无需再 router.refresh()。
 */
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
