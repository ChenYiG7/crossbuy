'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@crossbuy/ui';

/**
 * 登录表单（client component）——POST 到客户面登录路由，
 * 成功后 router.refresh() 让 RSC 带着新 cookie 重取（无需整页跳转）。
 */
export function LoginForm({ message }: { message?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      const json: { code: number; message: string } = await res.json();
      if (!res.ok || json.code !== 0) {
        setError(json.message || '登录失败，请稍后重试');
        setPending(false);
        return;
      }
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
      setPending(false);
    }
  }

  return (
    <form action={onSubmit} className="grid gap-4">
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      <div className="grid gap-2">
        <Label htmlFor="username">账号（邮箱或用户名）</Label>
        <Input id="username" name="username" autoComplete="username" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">密码</Label>
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
        <Label htmlFor="rememberMe">记住我（30 天）</Label>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending} className="w-fit">
        {pending ? '登录中…' : '登录'}
      </Button>
    </form>
  );
}
