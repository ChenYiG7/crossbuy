'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Input, Label } from '@crossbuy/ui';

/**
 * 登录表单（client component）——POST 到客户面登录路由，
 * 成功后 router.refresh() 让 RSC 带着新 cookie 重取（无需整页跳转）。
 *
 * 错误展示按稳定错误码查 errors 词典（errCode 由 HTTP 面的 Envelope.errCode
 * 或 RSC 直调路径的域/AuthError code 下传），未命中回退展示服务端 message。
 */
export function LoginForm({ message, errorCode }: { message?: string; errorCode?: string }) {
  const router = useRouter();
  const t = useTranslations('member');
  const te = useTranslations('errors');
  const [error, setError] = useState<{ message?: string; code?: string } | null>(null);
  const [pending, setPending] = useState(false);

  const initialMessage = errorCode && te.has(errorCode) ? te(errorCode) : (message ?? undefined);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/customer/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: String(formData.get('username') ?? ''),
          password: String(formData.get('password') ?? ''),
          rememberMe: formData.get('rememberMe') === 'on',
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
      {initialMessage ? <p className="text-sm text-muted-foreground">{initialMessage}</p> : null}
      <div className="grid gap-2">
        <Label htmlFor="username">{t('账号（邮箱或用户名）')}</Label>
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
      <div className="flex items-center gap-2">
        <input
          id="rememberMe"
          name="rememberMe"
          type="checkbox"
          className="size-4 rounded border-input"
        />
        <Label htmlFor="rememberMe">{t('记住我（30 天）')}</Label>
      </div>
      {shownError ? <p className="text-sm text-destructive">{shownError}</p> : null}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? t('登录中…') : t('登录')}
      </Button>
    </form>
  );
}
