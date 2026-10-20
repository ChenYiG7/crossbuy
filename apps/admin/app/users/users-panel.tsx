'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('users');

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
            {t('用户管理')}
            <Badge variant={scope === 'all' ? 'default' : 'secondary'}>{scopeLabel}</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('共 {total} 人（只读视图——写路径仍走旧后台，直到域绞杀切换）', {
              total: initial.total,
            })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onLogout}>
          {t('登出')}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form action={onSearch} className="flex gap-2">
          <Input name="q" placeholder={t('用户名 / 真名 / 邮箱 / 客户代号')} className="max-w-xs" />
          <Button type="submit" variant="secondary" size="sm">
            {t('搜索')}
          </Button>
        </form>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">UID</th>
                <th className="py-2 pr-4 font-medium">{t('用户名')}</th>
                <th className="py-2 pr-4 font-medium">{t('真名')}</th>
                <th className="py-2 pr-4 font-medium">{t('邮箱')}</th>
                <th className="py-2 pr-4 font-medium">{t('客户代号')}</th>
                <th className="py-2 pr-4 font-medium">{t('类型')}</th>
                <th className="py-2 pr-4 font-medium">{t('状态')}</th>
                <th className="py-2 pr-4 font-medium">{t('余额（CNY）')}</th>
              </tr>
            </thead>
            <tbody>
              {initial.items.map((u: AdminUserListItem) => {
                const utypeKey = UTYPE_KEY[u.utype];
                const stateKey = STATE_KEY[u.state];
                return (
                  <tr key={u.uid} className="border-b last:border-0">
                    <td className="py-2 pr-4 tabular-nums">{u.uid}</td>
                    <td className="py-2 pr-4">{u.uname}</td>
                    <td className="py-2 pr-4">{u.tname ?? '—'}</td>
                    <td className="py-2 pr-4">{u.email ?? '—'}</td>
                    <td className="py-2 pr-4">{u.memberid || '—'}</td>
                    <td className="py-2 pr-4">{utypeKey ? t(utypeKey) : u.utype}</td>
                    <td className="py-2 pr-4">{stateKey ? t(stateKey) : u.state}</td>
                    <td className="py-2 pr-4 tabular-nums">¥{u.money}</td>
                  </tr>
                );
              })}
              {initial.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-muted-foreground">
                    {scope === 'none'
                      ? t(
                          '当前账号未绑定业务员分组，无可见客户（旧后台同款行为——请联系管理员绑定角色）',
                        )
                      : t('无匹配记录')}
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

/** 旧 Model::$utype 值 → 词典 key（对照旧 User.php 常用值；完整词表随 admin 铺开核对） */
const UTYPE_KEY: Record<number, string> = {
  0: '普通',
  1: '按次收费',
  2: '包月收费',
};

const STATE_KEY: Record<number, string> = {
  0: '未审核',
  1: '正常',
  [-1]: '审核未过',
  3: '禁止使用',
  4: '登录限制',
};
