'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@crossbuy/ui';

/** 登出按钮：清 cookie 后刷新 RSC（回登录态） */
export function LogoutButton() {
  const router = useRouter();
  const t = useTranslations('common');
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        await fetch('/api/customer/v1/auth/logout', { method: 'POST' });
        router.refresh();
      }}
    >
      {t('退出登录')}
    </Button>
  );
}
