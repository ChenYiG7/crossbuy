/**
 * i18n 配置（web 端）——三端同构小样板，有意不抽共享包/生成器：
 * 各端默认语言（web/mzk=ja 对客，admin=zh 内部）、目录位置、词典均分端演化，
 * 每端 ~40 行接线，抽象成本反超收益（docs/07「生成器优先」针对持续膨胀的域样板）。
 *
 * 模式：cookie（NEXT_LOCALE）+ 无 URL 前缀（若依式）——URL 恒定，日语用户默认 ja
 * 零感知；词典 key = 中文原文（开发母语读码即懂），zh.json 仅登记带 ICU 插值 {var}
 * 的词条（回退 key 不做变量插值，如 favorites 统计行），其余词条回退 key 本身
 * （中文），漏翻译时同样显示中文而非报错。
 */
export const LOCALES = ['ja', 'en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
/** 对客日本市场默认日语 */
export const DEFAULT_LOCALE: Locale = 'ja';
export const LOCALE_COOKIE = 'NEXT_LOCALE';

export function isLocale(value: string | undefined | null): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? '');
}
