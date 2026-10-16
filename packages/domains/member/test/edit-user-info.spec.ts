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
import { MemberServiceImpl } from '../src/service';

/** 事务回滚：结果带出来，改动全部丢弃（dump 库不能被测试写脏） */
class Rollback extends Error {}

async function withRollback<T>(fn: (tx: typeof legacyPrisma) => Promise<T>): Promise<T> {
  let result: T;
  try {
    await legacyPrisma.$transaction(async (tx) => {
      result = await fn(tx as typeof legacyPrisma);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return result!;
}

describe('EditUserInfo（旧 PHPUnit EditUserInfoTest 翻译）', () => {
  it('成功路径：合法入参应写入并可读回', async () => {
    const uid = await withRollback(async (tx) => {
      const [row] = await tx.dg_users.findMany({ select: { uid: true }, take: 1 });
      return row.uid;
    });

    await withRollback(async (tx) => {
      const service = new MemberServiceImpl(new MemberRepository(tx));
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

  it('无效 regType（3）应被契约拒绝 —— 源：testEditUserInfoErrorWithInvalidRegType', async () => {
    const service = new MemberServiceImpl(new MemberRepository(legacyPrisma));
    const res = await service.updateProfile(memberPrincipal(1), { regType: 3 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('MEMBER_PROFILE_INVALID');
  });

  it('无效 useType（9）应被契约拒绝 —— 源：testEditUserInfoErrorWithInvalidUseType', async () => {
    const service = new MemberServiceImpl(new MemberRepository(legacyPrisma));
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
        const service = new MemberServiceImpl(new MemberRepository(tx));
        const res = await service.updateProfile(memberPrincipal(uid), { useType });
        expect(res.ok).toBe(true);
        const after = await new MemberRepository(tx).findProfile(uid);
        expect(after?.usetype).toBe(useType); // 不是 true
      });
    }
  });
});
