'use client';

import type { MemberProfile } from '@crossbuy/contract';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crossbuy/ui';
import { LogoutButton } from './logout-button';

/** useType 词表（旧 App\Models\User：usetype 1..5） */
const USE_TYPE_LABEL: Record<number, string> = {
  1: '代理購入',
  2: '転送',
  3: '無在庫',
  4: 'OEM',
  5: '1688转运',
};

function Field({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? '—'}</dd>
    </div>
  );
}

/** 会员资料视图（server component；docs/04 客户面 BFF+RSC 直调域服务） */
export function ProfileView({ profile, onEdit }: { profile: MemberProfile; onEdit?: () => void }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">
            {profile.trueName || profile.uname}
            {profile.dfFlag ? <Badge variant="secondary">代发</Badge> : null}
          </CardTitle>
          <CardDescription>
            UID {profile.uid} · {profile.email ?? profile.uname}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {onEdit ? (
            <Button variant="outline" size="sm" onClick={onEdit}>
              编辑资料
            </Button>
          ) : null}
          <LogoutButton />
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="用户名" value={profile.uname} />
          <Field label="余额（CNY）" value={`¥ ${profile.money}`} />
          <Field
            label="会员类型"
            value={
              profile.useType != null ? (USE_TYPE_LABEL[profile.useType] ?? null) : null
            }
          />
          <Field label="账号类型" value={profile.regType === 1 ? '公司' : '个人'} />
          <Field label="姓名" value={profile.trueName} />
          <Field label="电话" value={profile.tel} />
          <Field label="国家/地区" value={profile.country} />
          <Field label="邮编" value={profile.zip} />
          <Field label="地址" value={profile.address} />
          <Field label="QQ" value={profile.qq} />
          <Field label="LINE" value={profile.line} />
          <Field label="微信" value={profile.wechat} />
          <Field label="公司名" value={profile.companyName} />
          <Field label="公司名（英）" value={profile.companyNameEng} />
          <Field label="公司负责人" value={profile.companyManager} />
          <Field label="公司电话" value={profile.companyTel} />
          <Field label="公司地址" value={profile.companyAddress} />
          <Field label="废弃原包装" value={profile.originPackageChoice === 1 ? '保留' : '废弃'} />
        </div>
        <p className="text-xs text-muted-foreground">
          资料编辑、未读消息、留言板等能力随所属域陆续接入（R1 按域灰度）。
        </p>
      </CardContent>
    </Card>
  );
}
