import { getWebConfig } from '@/config';

/** 会话 cookie 名（HttpOnly；JS 读不到，防 XSS 窃取） */
export const SESSION_COOKIE_NAME = 'cb_session';

/**
 * 会话 cookie 选项：
 * - httpOnly：禁 JS 读取
 * - sameSite=lax：导航 GET 带 cookie（站内跳转不掉登录），跨站 POST 不带（CSRF 基线防护）
 * - secure：仅生产（本地 http 开发不能设，否则浏览器丢弃）
 * - path=/：三端同域下按路径分流由 nginx 负责，cookie 不区分 app
 */
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
    secure: getWebConfig().NODE_ENV === 'production',
    path: '/',
    maxAge: ttlSeconds,
  };
}
