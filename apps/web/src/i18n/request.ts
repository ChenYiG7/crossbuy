import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from './config';

/**
 * next-intl 请求级配置：从 cookie 读语言偏好，缺省 ja。
 *
 * - messages 动态 import（模板串）会被构建期内联进 server chunk，
 *   standalone 产物无运行时 fs 依赖——勿改成 fs 读文件（nft trace 漏文件）。
 * - onError 静默：缺词条时 next-intl 返回 key 本身（=中文），恰是兜底语义，
 *   不配会刷 console.error。zh.json 为空词典（key 即中文），同样依赖此回退。
 * - 读 cookies() 使所有 RSC 页面变 dynamic：member 页本就 dynamic，
 *   首页失去 prerender 在当前体量无感（R1 骨架期有意接受）。
 */
export default getRequestConfig(async () => {
  const raw = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    onError: () => {},
  };
});
