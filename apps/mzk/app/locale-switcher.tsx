'use client';

import { useLocale } from 'next-intl';
import { useTransition } from 'react';
import { Button } from '@crossbuy/ui';
import { LOCALES } from '../i18n/config';
import { setLocale } from '../i18n/set-locale';

/**
 * 语言切换器（client component；机制说明见 apps/web/app/locale-switcher.tsx）。
 * 各 app 自带一份（import 各自的 action/常量），有意不上收 packages/ui。
 */
const LOCALE_LABEL: Record<(typeof LOCALES)[number], string> = {
  zh: '中文',
  ja: '日本語',
  en: 'English',
};

export function LocaleSwitcher() {
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1" aria-busy={pending}>
      {LOCALES.map((l) => (
        <Button
          key={l}
          type="button"
          variant={l === locale ? 'default' : 'outline'}
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => setLocale(l))}
        >
          {LOCALE_LABEL[l]}
        </Button>
      ))}
    </div>
  );
}
