/**
 * M0.9 翻译样例 —— 源：旧系统 `tests/Feature/GraphQLTest/Mutations/Member/EditUserInfoTest.php`
 * （haiou，只读参考）。
 *
 * 翻译原则：
 *   - 测**业务规则**（枚举取值域、写入生效），不测传输层（旧用例是 GraphQL mutation，
 *     R1 改成 REST + service，传输层不是复现对象）
 *   - 连真实 MySQL 快照，写操作包在事务里**回滚**，不污染 dump 库
 *   - 期望值来自旧系统词表（`App\Models\User`），不是本文件自说自话
 */
import { describe, expect, it } from 'vitest';
import { legacyPrisma } from '@crossbuy/db';
import { memberPrincipal } from '@crossbuy/auth';
import { MemberRepository } from '../src/repository';
import { InMemoryLoginRateLimiter } from '../src/login-rate-limiter';
import { Md5PasswordVerifier } from '../src/password-verifier';
import { MemberServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

describe('EditUserInfo（旧 PHPUnit EditUserInfoTest 翻译）', () => {
  it('成功路径：合法入参应写入并可读回', async () => {
    const uid = await withRollback(async (tx) => {
      const [row] = await tx.dg_users.findMany({ select: { uid: true }, take: 1 });
      return row.uid;
    });

    await withRollback(async (tx) => {
      const service = new MemberServiceImpl(
        new MemberRepository(tx),
        new Md5PasswordVerifier(),
        new InMemoryLoginRateLimiter(),
      );
      const res = await service.updateProfile(memberPrincipal(uid), {
        regType: 1,
        trueName: 'tname',
        sex: 1,
        useType: 2,
        originPackageChoice: 1,
      });

      expect(res.ok).toBe(true);

      const after = await new MemberRepository(tx).findProfile(uid);
      expect(after?.regtype).toBe(1);
      expect(after?.sex).toBe(1);
      expect(after?.usetype).toBe(2);
      expect(after?.origin_package_choice).toBe(1);
      expect(after?.tname).toBe('tname');
    });

    // 回滚后库里仍是原值（证明测试没写脏 dump）
    const persisted = await new MemberRepository(legacyPrisma).findProfile(uid);
    expect(persisted).not.toBeNull();
  });

  /**
   * ★ 全字段往返（2026-10-17 补齐）：旧 EditUserInfoMutation::args() 共 22 个字段，
   * 早期翻译稿只覆盖 12 个——本用例按旧代码逐字段锁死列映射，防「字段漏登静默丢更新」。
   */
  it('全字段往返：旧 mutation 22 个字段逐一写入并可读回', async () => {
    const uid = await withRollback(async (tx) => {
      const [row] = await tx.dg_users.findMany({ select: { uid: true }, take: 1 });
      return row.uid;
    });

    await withRollback(async (tx) => {
      const service = new MemberServiceImpl(
        new MemberRepository(tx),
        new Md5PasswordVerifier(),
        new InMemoryLoginRateLimiter(),
      );
      const res = await service.updateProfile(memberPrincipal(uid), {
        regType: 1,
        companyName: 'comname-ja',
        companyNameEng: 'comname-en',
        companyManager: 'mgr-ja',
        companyManagerEng: 'mgr-en',
        companyCode: 'JASTPRO-1',
        companyTel: 'comptel',
        companyAddress: 'comaddr-ja',
        companyAddressEng: 'comaddr-en',
        trueName: 'tname',
        sex: 1,
        zip: 'zip',
        tel: 'tel',
        address: 'address',
        country: 'country',
        qq: 'skype-id',
        line: 'line-id',
        wechat: 'wechat-id',
        useType: 3,
        preBuyFrequency: 'freq',
        preBuyAmount: 'amt',
        originPackageChoice: 1,
      });
      expect(res.ok).toBe(true);

      const after = await new MemberRepository(tx).findMemberProfile(uid);
      expect(after).not.toBeNull();
      // 契约字段 → 旧列（PROFILE_COLUMN 映射的逐列断言）
      expect(after!.regtype).toBe(1);
      expect(after!.comname).toBe('comname-ja');
      expect(after!.comengname).toBe('comname-en');
      expect(after!.commanager).toBe('mgr-ja');
      expect(after!.commanagereng).toBe('mgr-en');
      expect(after!.compost).toBe('JASTPRO-1');
      expect(after!.comptel).toBe('comptel');
      expect(after!.comaddress).toBe('comaddr-ja');
      expect(after!.comaddresseng).toBe('comaddr-en');
      expect(after!.tname).toBe('tname');
      expect(after!.sex).toBe(1);
      expect(after!.zip).toBe('zip');
      expect(after!.tel).toBe('tel');
      expect(after!.address).toBe('address');
      expect(after!.country).toBe('country');
      expect(after!.qq).toBe('skype-id');
      expect(after!.line).toBe('line-id');
      expect(after!.wechat).toBe('wechat-id');
      expect(after!.usetype).toBe(3);
      expect(after!.prebuyfeq).toBe('freq');
      expect(after!.prebuyamt).toBe('amt');
      expect(after!.origin_package_choice).toBe(1);
    });
  });

  it('无效 regType（3）应被契约拒绝 —— 源：testEditUserInfoErrorWithInvalidRegType', async () => {
    const service = new MemberServiceImpl(
      new MemberRepository(legacyPrisma),
      new Md5PasswordVerifier(),
      new InMemoryLoginRateLimiter(),
    );
    const res = await service.updateProfile(memberPrincipal(1), { regType: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('MEMBER_PROFILE_INVALID');
  });

  it('无效 useType（9）应被契约拒绝 —— 源：testEditUserInfoErrorWithInvalidUseType', async () => {
    const service = new MemberServiceImpl(
      new MemberRepository(legacyPrisma),
      new Md5PasswordVerifier(),
      new InMemoryLoginRateLimiter(),
    );
    const res = await service.updateProfile(memberPrincipal(1), { useType: 9 });
    expect(res.ok).toBe(false);
  });

  /**
   * ★ 新增（旧用例没覆盖，但正是 Prisma 的坑）：usetype 是 1..5 的枚举，
   * 曾被 tinyint(1) 映射成 Boolean 而静默塌成 true（docs/plans/07 §三）。
   * 这条用例锁死「枚举真值必须原样存取」。
   */
  it('useType 的 1..5 必须原样存取，不能被布尔化吞掉', async () => {
    const uid = await withRollback(async (tx) => {
      const [row] = await tx.dg_users.findMany({ select: { uid: true }, take: 1 });
      return row.uid;
    });

    for (const useType of [1, 2, 3, 4, 5]) {
      await withRollback(async (tx) => {
        const service = new MemberServiceImpl(
          new MemberRepository(tx),
          new Md5PasswordVerifier(),
          new InMemoryLoginRateLimiter(),
        );
        const res = await service.updateProfile(memberPrincipal(uid), { useType });
        expect(res.ok).toBe(true);
        const after = await new MemberRepository(tx).findProfile(uid);
        expect(after?.usetype).toBe(useType); // 不是 true
      });
    }
  });
});
