/**
 * i18n 配置（mzk 端）——三端同构小样板，有意不抽共享包/生成器（机制说明见
 * apps/web/src/i18n/config.ts）。mzk 对客代发端 → 默认 ja；mzk 无 src 目录，
 * i18n 接线放 app 同级根。
 */
export const LOCALES = ['ja', 'en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ja';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? '');
}
