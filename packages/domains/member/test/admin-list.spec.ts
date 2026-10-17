/**
 * admin 只读用户列表测试（docs/06 §四-4；M1 member 域新增面）。
 *
 * 锁的规则 = 旧 UserController::grid 三分支数据范围：
 *   - flags：memberid LIKE '{flag}%' OR memberid='' / NULL（未分组客户**所有人可见**）
 *   - none：service 短路空集（旧 1=0 分支，不发查询）
 *   - all：不过滤
 * 以及 q 关键字 LIKE 与分页（REST 面新增便利项）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { legacyPrisma } from '@crossbuy/db';
import { MemberRepository } from '../src/repository';
import { MemberServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

function md5(raw: string): string {
  return createHash('md5').update(raw, 'utf8').digest('hex');
}

function makeService(tx: typeof legacyPrisma): MemberServiceImpl {
  return new MemberServiceImpl(
    new MemberRepository(tx),
    { verify: () => true },
    { attempt: () => true },
  );
}

async function insertUser(
  tx: typeof legacyPrisma,
  overrides: { uname: string; memberid?: string | null; money?: string },
): Promise<number> {
  const row = await tx.dg_users.create({
    data: {
      uname: overrides.uname,
      password: md5('test'),
      card: 'test',
      validity: 1,
      memberid: overrides.memberid === undefined ? 'testmember' : overrides.memberid,
      email: `${overrides.uname}@example.com`,
      money: overrides.money ?? '50.00',
    },
    select: { uid: true },
  });
  return row.uid;
}

describe('listForAdmin 数据范围', () => {
  it('flags=["G"]：G 前缀 + 空 memberid + NULL memberid 可见，H 前缀不可见', async () => {
    await withRollback(async (tx) => {
      await insertUser(tx, { uname: 'vitest-adm-g1', memberid: 'G001' });
      await insertUser(tx, { uname: 'vitest-adm-h1', memberid: 'H001' });
      await insertUser(tx, { uname: 'vitest-adm-none', memberid: '' });
      await insertUser(tx, { uname: 'vitest-adm-null', memberid: null });

      const res = await makeService(tx).listForAdmin({ kind: 'flags', flags: ['G'] }, { page: 1, limit: 50 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const unames = res.value.items.map((i) => i.uname);
      expect(unames).toContain('vitest-adm-g1');
      expect(unames).toContain('vitest-adm-none');
      expect(unames).toContain('vitest-adm-null');
      expect(unames).not.toContain('vitest-adm-h1');
    });
  });

  it('none → 短路空集（total=0，旧 1=0 分支）', async () => {
    await withRollback(async (tx) => {
      await insertUser(tx, { uname: 'vitest-adm-any' });
      const res = await makeService(tx).listForAdmin({ kind: 'none' }, { page: 1, limit: 20 });
      expect(res).toEqual({ ok: true, value: { items: [], total: 0, page: 1, limit: 20 } });
    });
  });

  it('all → 不过滤（total 覆盖夹具）+ q 关键字 LIKE 命中 uname', async () => {
    await withRollback(async (tx) => {
      await insertUser(tx, { uname: 'vitest-adm-searchme', memberid: 'Z900' });
      await insertUser(tx, { uname: 'vitest-adm-other', memberid: 'Z901' });

      const all = await makeService(tx).listForAdmin({ kind: 'all' }, { page: 1, limit: 100 });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      const unames = all.value.items.map((i) => i.uname);
      expect(unames).toContain('vitest-adm-searchme');
      expect(unames).toContain('vitest-adm-other');

      const filtered = await makeService(tx).listForAdmin({ kind: 'all' }, { q: 'searchme', page: 1, limit: 100 });
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) return;
      expect(filtered.value.items.map((i) => i.uname)).toEqual(['vitest-adm-searchme']);
    });
  });

  it('money 字符串承载（禁浮点）+ 分页 limit 生效', async () => {
    await withRollback(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await insertUser(tx, { uname: `vitest-adm-page${i}`, memberid: `P00${i}`, money: `${i}.25` });
      }
      const res = await makeService(tx).listForAdmin({ kind: 'all' }, { q: 'vitest-adm-page', page: 1, limit: 2 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.total).toBe(3);
      expect(res.value.items.length).toBe(2);
      expect(res.value.items.every((i) => typeof i.money === 'string')).toBe(true);
    });
  });
});
