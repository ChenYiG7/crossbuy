import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from './config';

/**
 * next-intl 请求级配置（机制详解见 apps/web/src/i18n/request.ts）：
 * cookie 读偏好，admin 缺省 zh；zh.json 仅登记带 ICU 插值的词条（回退 key
 * 不做变量插值），其余词条回退 key 本身（中文）。
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
