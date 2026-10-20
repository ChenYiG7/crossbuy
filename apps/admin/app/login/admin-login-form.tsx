'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Input, Label } from '@crossbuy/ui';

/** 后台登录表单（client component；机制同 web 会员端 LoginForm） */
export function AdminLoginForm() {
  const router = useRouter();
  const t = useTranslations('common');
  const te = useTranslations('errors');
  const [error, setError] = useState<{ message?: string; code?: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: String(formData.get('username') ?? ''),
          password: String(formData.get('password') ?? ''),
        }),
      });
      const json: { code: number; message: string; errCode?: string } = await res.json();
      if (!res.ok || json.code !== 0) {
        setError({ message: json.message || t('登录失败，请稍后重试'), code: json.errCode });
        setPending(false);
        return;
      }
      router.refresh();
    } catch {
      setError({ message: t('网络异常，请稍后重试') });
      setPending(false);
    }
  }

  const shownError = error && error.code && te.has(error.code) ? te(error.code) : error?.message;

  return (
    <form action={onSubmit} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="username">{t('用户名')}</Label>
        <Input id="username" name="username" autoComplete="username" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">{t('密码')}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {shownError ? <p className="text-sm text-destructive">{shownError}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t('登录中…') : t('登录')}
      </Button>
    </form>
  );
}
