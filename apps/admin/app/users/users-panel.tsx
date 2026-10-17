'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '@crossbuy/ui';
import type { AdminUserListItem, AdminUserListResult } from '@crossbuy/contract';

/**
 * 用户列表（client 交互区：搜索框 + 表格 + 登出）。
 * 数据获取在 RSC（直调 member service），本组件只负责筛选提交与展示。
 */
export function UsersPanel({
  scopeLabel,
  scope,
  initial,
}: {
  scopeLabel: string;
  scope: 'all' | 'flags' | 'none';
  initial: AdminUserListResult;
}) {
  const router = useRouter();

  function onSearch(formData: FormData) {
    const q = String(formData.get('q') ?? '').trim();
    router.push(q ? `/users?q=${encodeURIComponent(q)}` : '/users');
  }

  async function onLogout() {
    await fetch('/api/admin/v1/auth/logout', { method: 'POST' });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">
            用户管理
            <Badge variant={scope === 'all' ? 'default' : 'secondary'}>{scopeLabel}</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            共 {initial.total} 人（只读视图——写路径仍走旧后台，直到域绞杀切换）
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onLogout}>
          登出
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form action={onSearch} className="flex gap-2">
          <Input name="q" placeholder="用户名 / 真名 / 邮箱 / 客户代号" className="max-w-xs" />
          <Button type="submit" variant="secondary" size="sm">
            搜索
          </Button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">UID</th>
                <th className="py-2 pr-4 font-medium">用户名</th>
                <th className="py-2 pr-4 font-medium">真名</th>
                <th className="py-2 pr-4 font-medium">邮箱</th>
                <th className="py-2 pr-4 font-medium">客户代号</th>
                <th className="py-2 pr-4 font-medium">类型</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-4 font-medium">余额（CNY）</th>
              </tr>
            </thead>
            <tbody>
              {initial.items.map((u: AdminUserListItem) => (
                <tr key={u.uid} className="border-b last:border-0">
                  <td className="py-2 pr-4 tabular-nums">{u.uid}</td>
                  <td className="py-2 pr-4">{u.uname}</td>
                  <td className="py-2 pr-4">{u.tname ?? '—'}</td>
                  <td className="py-2 pr-4">{u.email ?? '—'}</td>
                  <td className="py-2 pr-4">{u.memberid || '—'}</td>
                  <td className="py-2 pr-4">{UTYPE_LABEL[u.utype] ?? u.utype}</td>
                  <td className="py-2 pr-4">{STATE_LABEL[u.state] ?? u.state}</td>
                  <td className="py-2 pr-4 tabular-nums">¥{u.money}</td>
                </tr>
              ))}
              {initial.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground">
                    {scope === 'none'
                      ? '当前账号未绑定业务员分组，无可见客户（旧后台同款行为——请联系管理员绑定角色）'
                      : '无匹配记录'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/** 旧 Model::$utype 词表（对照旧 User.php 常用值；完整词表随 admin 铺开核对） */
const UTYPE_LABEL: Record<number, string> = {
  0: '普通',
  1: '按次收费',
  2: '包月收费',
};

const STATE_LABEL: Record<number, string> = {
  0: '未审核',
  1: '正常',
  [-1]: '审核未过',
  3: '禁止使用',
  4: '登录限制',
};
