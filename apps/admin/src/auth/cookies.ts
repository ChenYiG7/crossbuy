import { getAdminConfig } from '@/config';

/** 后台会话 cookie 名（与会员端 cb_session 分离——同机双端登录互不覆盖） */
export const ADMIN_SESSION_COOKIE_NAME = 'cb_admin_session';

export function sessionCookieOptions(ttlSeconds: number): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: getAdminConfig().NODE_ENV === 'production',
    path: '/',
    maxAge: ttlSeconds,
  };
}
