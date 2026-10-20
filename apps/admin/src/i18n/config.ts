/**
 * i18n 配置（admin 端）——三端同构小样板，有意不抽共享包/生成器（机制说明见
 * apps/web/src/i18n/config.ts）。
 *
 * admin 是内部运营后台，用户是中文团队 → 默认 zh（zh.json 仅登记带 ICU 插值
 * {var} 的词条——回退 key 不做变量插值，其余词条回退 key 本身=中文）；
 * ja/en 供对日沟通时切换。
 */
export const LOCALES = ['ja', 'en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? '');
}
