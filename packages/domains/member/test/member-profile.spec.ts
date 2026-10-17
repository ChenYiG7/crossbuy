/**
 * M1 翻译 —— 源：旧系统 `tests/Feature/GraphQLTest/Queries/Member/GetUserInfoTest.php`
 * （haiou，只读参考）。
 *
 * 覆盖：dg_users 核心字段的全量映射（旧 assertJson 逐字段对应）。
 * **未覆盖**（随属主域落地补齐，别域数据禁直连表——docs/04 §3.2-1）：
 *   unreadInstantChat（Yunjiao 表）→ ticket/notify 域
 *   unreadGuestBook（Guestbook 表）→ content/ticket 域
 *   emailSubscribeStatus（email_subscribe_status 位运算）→ notify 域
 *   businessManager（AdminUser 按 memberid 前缀匹配）→ admin 域
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyPrisma } from '@crossbuy/db';
import { memberPrincipal } from '@crossbuy/auth';
import { USE_TYPE } from '@crossbuy/contract';
import { InMemoryLoginRateLimiter } from '../src/login-rate-limiter';
import { Md5PasswordVerifier } from '../src/password-verifier';
import { MemberRepository } from '../src/repository';
import { MemberServiceImpl, parseUseInquiry } from '../src/service';
import { withRollback } from './helpers/rollback';

function md5(raw: string): string {
  return createHash('md5').update(raw, 'utf8').digest('hex');
}

function makeService(tx: typeof legacyPrisma) {
  return new MemberServiceImpl(
    new MemberRepository(tx),
    new Md5PasswordVerifier(),
    new InMemoryLoginRateLimiter(),
  );
}

describe('getProfile（旧 PHPUnit GetUserInfoTest 翻译）', () => {
  it('全量字段映射：旧 assertJson 的每个字段逐一对应', async () => {
    await withRollback(async (tx) => {
      const created = await tx.dg_users.create({
        data: {
          uname: 'vitest-profile-full',
          password: md5('x'),
          card: 'test',
          validity: 1,
          email: 'vitest-profile-full@example.com',
          regtype: 1,
          comname: 'comname',
          comengname: 'comengname',
          commanager: 'commanager',
          commanagereng: 'commanagereng',
          compost: 'compost',
          comptel: 'comptel',
          comaddress: 'comaddress',
          comaddresseng: 'comaddresseng',
          tname: 'tname',
          sex: 0,
          zip: 'zip',
          tel: 'tel',
          address: 'address',
          country: 'country',
          qq: 'qq',
          line: 'line',
          wechat: 'wechat',
          usetype: USE_TYPE.FORWARD,
          prebuyfeq: 'prebuyfeq',
          prebuyamt: 'prebuyamt',
          money: 100,
          dfflag: 1,
          face: 'https://www.baidu.com',
          reg_extra: JSON.stringify({ useInquiry: true }),
          origin_package_choice: 0,
        },
        select: { uid: true },
      });

      const res = await makeService(tx).getProfile(memberPrincipal(created.uid));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const p = res.value;

      // —— 与旧 assertJson 逐字段对应（GraphQL alias → 契约字段）——
      expect(p.uid).toBe(created.uid);
      expect(p.uname).toBe('vitest-profile-full');
      expect(p.email).toBe('vitest-profile-full@example.com');
      expect(p.regType).toBe(1);
      expect(p.companyName).toBe('comname');
      expect(p.companyNameEng).toBe('comengname');
      expect(p.companyManager).toBe('commanager');
      expect(p.companyManagerEng).toBe('commanagereng');
      expect(p.companyCode).toBe('compost'); // ← compost 不是统一社会信用代码
      expect(p.companyTel).toBe('comptel');
      expect(p.companyAddress).toBe('comaddress');
      expect(p.companyAddressEng).toBe('comaddresseng');
      expect(p.trueName).toBe('tname');
      expect(p.sex).toBe(0);
      expect(p.zip).toBe('zip');
      expect(p.tel).toBe('tel');
      expect(p.address).toBe('address');
      expect(p.country).toBe('country');
      expect(p.qq).toBe('qq');
      expect(p.line).toBe('line');
      expect(p.wechat).toBe('wechat');
      expect(p.useType).toBe(2); // 枚举真值，禁布尔化
      expect(p.preBuyFrequency).toBe('prebuyfeq');
      expect(p.preBuyAmount).toBe('prebuyamt');
      expect(p.money).toBe('100'); // Decimal → 字符串，禁浮点
      expect(p.dfFlag).toBe(true); // dfflag=1 → boolean
      expect(p.avatar).toBe('https://www.baidu.com');
      expect(p.useInquiry).toBe(true); // reg_extra JSON
      expect(p.originPackageChoice).toBe(0); // ORIGIN_PACKAGE_DISCARD
    });
  });

  it('originPackageChoice=保留（旧 testCurrentUserInfoOriginPackageChoiceKeep）', async () => {
    await withRollback(async (tx) => {
      const created = await tx.dg_users.create({
        data: {
          uname: 'vitest-profile-keep',
          password: md5('x'),
          card: 'test',
          validity: 1,
          origin_package_choice: 1,
        },
        select: { uid: true },
      });
      const res = await makeService(tx).getProfile(memberPrincipal(created.uid));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.originPackageChoice).toBe(1);
    });
  });

  it('useInquiry：reg_extra 缺省/非法 JSON → false', async () => {
    await withRollback(async (tx) => {
      const a = await tx.dg_users.create({
        data: { uname: 'vitest-profile-noextra', password: md5('x'), card: 't', validity: 1 },
        select: { uid: true },
      });
      const b = await tx.dg_users.create({
        data: {
          uname: 'vitest-profile-badextra',
          password: md5('x'),
          card: 't',
          validity: 1,
          reg_extra: 'not-json{{',
        },
        select: { uid: true },
      });
      const service = makeService(tx);
      const ra = await service.getProfile(memberPrincipal(a.uid));
      const rb = await service.getProfile(memberPrincipal(b.uid));
      expect(ra.ok && ra.value.useInquiry).toBe(false);
      expect(rb.ok && rb.value.useInquiry).toBe(false);
    });
  });

  it('dfFlag=0 → false；useType 的 1..5 枚举原样读出', async () => {
    await withRollback(async (tx) => {
      const created = await tx.dg_users.create({
        data: {
          uname: 'vitest-profile-df0',
          password: md5('x'),
          card: 't',
          validity: 1,
          dfflag: 0,
          usetype: USE_TYPE.TRANSFER_1688,
        },
        select: { uid: true },
      });
      const res = await makeService(tx).getProfile(memberPrincipal(created.uid));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.dfFlag).toBe(false);
      expect(res.value.useType).toBe(5);
    });
  });

  it('会员不存在 → MEMBER_NOT_FOUND', async () => {
    const res = await makeService(legacyPrisma).getProfile(memberPrincipal(999_999_999));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('MEMBER_NOT_FOUND');
  });

  it('非会员主体 → MEMBER_PRINCIPAL_INVALID', async () => {
    const res = await makeService(legacyPrisma).getProfile({
      subject: '1',
      kind: 'admin',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('MEMBER_PRINCIPAL_INVALID');
  });
});

describe('parseUseInquiry（reg_extra JSON 解析容错）', () => {
  it('各形态输入的预期值', () => {
    expect(parseUseInquiry(null)).toBe(false);
    expect(parseUseInquiry('')).toBe(false);
    expect(parseUseInquiry('not-json')).toBe(false);
    expect(parseUseInquiry('{}')).toBe(false);
    expect(parseUseInquiry('{"useInquiry":false}')).toBe(false);
    expect(parseUseInquiry('{"useInquiry":true}')).toBe(true);
    expect(parseUseInquiry('{"other":1,"useInquiry":true}')).toBe(true);
    // 旧系统 PHP 侧 `?? false`：非布尔真值不认（GraphQL Boolean 强转前的保守行为）
    expect(parseUseInquiry('{"useInquiry":"yes"}')).toBe(false);
  });
});
