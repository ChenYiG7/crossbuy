'use client';

import type { MemberProfile } from '@crossbuy/contract';
import { useTranslations } from 'next-intl';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@crossbuy/ui';
import { LogoutButton } from './logout-button';

/** useType 值 → 词典 key（旧 App\Models\User：usetype 1..5；文案在 messages） */
const USE_TYPE_KEY: Record<number, string> = {
  1: '代购',
  2: '转运',
  3: '无库存',
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

/** 会员资料视图（docs/04 客户面 BFF+RSC 直调域服务） */
export function ProfileView({ profile, onEdit }: { profile: MemberProfile; onEdit?: () => void }) {
  const t = useTranslations('member');
  const useTypeKey = profile.useType != null ? USE_TYPE_KEY[profile.useType] : undefined;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">
            {profile.trueName || profile.uname}
            {profile.dfFlag ? <Badge variant="secondary">{t('代发')}</Badge> : null}
          </CardTitle>
          <CardDescription>
            UID {profile.uid} · {profile.email ?? profile.uname}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          {onEdit ? (
            <Button variant="outline" size="sm" onClick={onEdit}>
              {t('编辑资料')}
            </Button>
          ) : null}
          <LogoutButton />
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('用户名')} value={profile.uname} />
          <Field label={t('余额（CNY）')} value={`¥ ${profile.money}`} />
          <Field label={t('会员类型')} value={useTypeKey ? t(useTypeKey) : null} />
          <Field label={t('账号类型')} value={profile.regType === 1 ? t('公司') : t('个人')} />
          <Field label={t('姓名')} value={profile.trueName} />
          <Field label={t('电话')} value={profile.tel} />
          <Field label={t('国家/地区')} value={profile.country} />
          <Field label={t('邮编')} value={profile.zip} />
          <Field label={t('地址')} value={profile.address} />
          <Field label={t('QQ')} value={profile.qq} />
          <Field label={t('LINE')} value={profile.line} />
          <Field label={t('微信')} value={profile.wechat} />
          <Field label={t('公司名')} value={profile.companyName} />
          <Field label={t('公司名（英）')} value={profile.companyNameEng} />
          <Field label={t('公司负责人')} value={profile.companyManager} />
          <Field label={t('公司电话')} value={profile.companyTel} />
          <Field label={t('公司地址')} value={profile.companyAddress} />
          <Field
            label={t('废弃原包装')}
            value={profile.originPackageChoice === 1 ? t('保留') : t('废弃')}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t('资料编辑、未读消息、留言板等能力随所属域陆续接入（R1 按域灰度）。')}
        </p>
      </CardContent>
    </Card>
  );
}
