'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@crossbuy/ui';

/** 后台登录表单（client component；机制同 web 会员端 LoginForm） */
export function AdminLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
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
      <div className="grid gap-2">
        <Label htmlFor="username">用户名</Label>
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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? '登录中…' : '登录'}
      </Button>
    </form>
  );
}
