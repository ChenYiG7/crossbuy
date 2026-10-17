'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@crossbuy/ui';
import {
  GENDER,
  ORIGIN_PACKAGE_CHOICE,
  REG_TYPE,
  USE_TYPE,
  type MemberProfile,
} from '@crossbuy/contract';

/**
 * 资料编辑表单（client component）——PATCH /api/customer/v1/member/me
 * （旧 EditUserInfo 的 REST 化，字段清单与旧 mutation args 1:1）。
 * 成功后 router.refresh() 让 RSC 带新数据重渲染。
 */

/** 旧 App\Models\User 词表（与 contract 常量同源，禁在 UI 另立字面量） */
const USE_TYPE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: USE_TYPE.AGENCY_PURCHASE, label: '代理購入' },
  { value: USE_TYPE.FORWARD, label: '転送' },
  { value: USE_TYPE.NO_STOCK, label: '無在庫' },
  { value: USE_TYPE.OEM, label: 'OEM' },
  { value: USE_TYPE.TRANSFER_1688, label: '1688转运' },
];

function TextField({
  name,
  label,
  defaultValue,
  type = 'text',
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  type?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue ?? ''} />
    </div>
  );
}

function SelectField({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: number | null;
  options: Array<{ value: number; label: string }>;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <select
        id={name}
        name={name}
        defaultValue={value ?? ''}
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="">未设置</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ProfileEditForm({
  profile,
  onCancel,
}: {
  profile: MemberProfile;
  onCancel: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(formData: FormData) {
    setPending(true);
    setError(null);
    // 只提交有值的字段（空串 = 不改，与旧 mutation「只传的字段才更新」语义一致；
    // 旧系统同样不支持「清空」——数据库里清空走后台，R1 不发明新语义）
    const payload: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string' && value !== '') payload[key] = value;
    }
    try {
      const res = await fetch('/api/customer/v1/member/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json: { code: number; message: string } = await res.json();
      if (!res.ok || json.code !== 0) {
        setError(json.message || '保存失败，请稍后重试');
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
    <form action={onSubmit} className="grid gap-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField name="trueName" label="姓名" defaultValue={profile.trueName} />
        <SelectField
          name="sex"
          label="性别"
          value={profile.sex}
          options={[
            { value: GENDER.FEMALE, label: '女性' },
            { value: GENDER.MALE, label: '男性' },
          ]}
        />
        <TextField name="tel" label="电话" defaultValue={profile.tel} />
        <TextField name="zip" label="邮政编码" defaultValue={profile.zip} />
        <TextField name="country" label="国家" defaultValue={profile.country} />
        <TextField name="qq" label="Skype（旧列 qq）" defaultValue={profile.qq} />
        <TextField name="line" label="LINE" defaultValue={profile.line} />
        <TextField name="wechat" label="微信" defaultValue={profile.wechat} />
        <TextField name="address" label="地址" defaultValue={profile.address} />
        <SelectField name="useType" label="会员类型" value={profile.useType} options={USE_TYPE_OPTIONS} />
        <TextField name="preBuyFrequency" label="预计购买频率" defaultValue={profile.preBuyFrequency} />
        <TextField name="preBuyAmount" label="预计采购金额" defaultValue={profile.preBuyAmount} />
        <TextField name="avatar" label="头像 URL" defaultValue={profile.avatar} />
        <SelectField
          name="originPackageChoice"
          label="原包装"
          value={profile.originPackageChoice}
          options={[
            { value: ORIGIN_PACKAGE_CHOICE.DISCARD, label: '废弃' },
            { value: ORIGIN_PACKAGE_CHOICE.KEEP, label: '保留' },
          ]}
        />
      </div>

      <div className="grid gap-3">
        <h3 className="text-sm font-medium">公司信息</h3>
        <SelectField
          name="regType"
          label="注册名义"
          value={profile.regType}
          options={[
            { value: REG_TYPE.PERSONAL, label: '个人' },
            { value: REG_TYPE.COMPANY, label: '公司' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="companyName" label="公司名（汉字）" defaultValue={profile.companyName} />
          <TextField name="companyNameEng" label="公司名（字母）" defaultValue={profile.companyNameEng} />
          <TextField name="companyManager" label="负责人（汉字）" defaultValue={profile.companyManager} />
          <TextField
            name="companyManagerEng"
            label="负责人（字母）"
            defaultValue={profile.companyManagerEng}
          />
          <TextField name="companyCode" label="公司编号 JASTPRO" defaultValue={profile.companyCode} />
          <TextField name="companyTel" label="公司电话" defaultValue={profile.companyTel} />
          <TextField name="companyAddress" label="公司地址（汉字）" defaultValue={profile.companyAddress} />
          <TextField
            name="companyAddressEng"
            label="公司地址（字母）"
            defaultValue={profile.companyAddressEng}
          />
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          取消
        </Button>
      </div>
    </form>
  );
}
