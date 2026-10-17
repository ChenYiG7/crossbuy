'use client';

import { useState } from 'react';
import type { MemberProfile } from '@crossbuy/contract';
import { ProfileView } from './profile-view';
import { ProfileEditForm } from './profile-edit-form';

/**
 * 会员资料区（client component）：查看 ⇄ 编辑 切换。
 * 数据由 server page 传入，编辑提交后 router.refresh() 让 RSC 重取——
 * 客户端只持有「当前在查看还是在编辑」这一个 UI 状态。
 */
export function ProfileSection({ profile }: { profile: MemberProfile }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <ProfileEditForm profile={profile} onCancel={() => setEditing(false)} />;
  }
  return <ProfileView profile={profile} onEdit={() => setEditing(true)} />;
}
