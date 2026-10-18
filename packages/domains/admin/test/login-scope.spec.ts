/**
 * admin 域登录 + RBAC 范围测试（M1 §四-4 admin 只读起步）。
 *
 * 翻译源：无直接 PHPUnit 用例（dcat 登录是框架行为）；测的是**我们复现的规则**：
 *   - bcrypt 校验（$2y$ 与 PHP Hash::check 等价）
 *   - 不存在 / 错密码 / 软删 → 同一错误码（禁枚举）
 *   - scope 三分支：ability-view-all-users → all；business_manager 分组 → flags；
 *     无权限无分组 → none（旧 grid 1=0 分支）
 *   - business_manager JSON 防御解析（旧 casts 'array' 的脏数据容忍）
 *
 * 数据隔离：withRollback 事务内造数据 + 复用 dump 里**已存在**的角色/权限行
 * （admin_permissions.slug 有唯一键——四个业务员角色与 view-all 权限都是真实行，
 * 只插关联行，禁插重名角色/权限）。
 */
import { hashSync } from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { legacyPrisma } from '@crossbuy/db';
import { AdminRepository } from '../src/repository';
import { BcryptPasswordVerifier } from '../src/password-verifier';
import { AdminServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

const PW = 'vitest-admin-pw';

function makeService(tx: typeof legacyPrisma): AdminServiceImpl {
  return new AdminServiceImpl(new AdminRepository(tx), new BcryptPasswordVerifier());
}

async function insertAdmin(
  tx: typeof legacyPrisma,
  username: string,
  opts: { businessManager?: string; deleted?: boolean } = {},
): Promise<number> {
  const row = await tx.admin_users.create({
    data: {
      username,
      password: hashSync(PW, 10),
      name: `测试管理员-${username}`,
      business_manager: opts.businessManager ?? null,
      ...(opts.deleted ? { deleted_at: new Date() } : {}),
    },
    select: { id: true },
  });
  return Number(row.id);
}

describe('admin login', () => {
  it('正确密码 → 200 + profile（scope=none，无权限无分组的默认值）', async () => {
    await withRollback(async (tx) => {
      await insertAdmin(tx, 'vitest-admin-ok');
      const res = await makeService(tx).login({ username: 'vitest-admin-ok', password: PW });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.username).toBe('vitest-admin-ok');
      expect(res.value.scope).toEqual({ kind: 'none' });
      // 名册来自 dump 真实业务员角色（flag 非空），格式 `名（flag）`
      expect(res.value.businessManagers.length).toBeGreaterThan(0);
      for (const entry of res.value.businessManagers) {
        expect(entry.label).toContain(`（${entry.flag}）`);
      }
    });
  });

  it('错误密码 → ADMIN_INVALID_CREDENTIALS', async () => {
    await withRollback(async (tx) => {
      await insertAdmin(tx, 'vitest-admin-badpw');
      const res = await makeService(tx).login({
        username: 'vitest-admin-badpw',
        password: 'wrong',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('ADMIN_INVALID_CREDENTIALS');
    });
  });

  it('不存在的用户 → 与错密码同一错误码（禁枚举）', async () => {
    await withRollback(async (tx) => {
      const res = await makeService(tx).login({ username: 'no-such-admin-xyz', password: PW });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('ADMIN_INVALID_CREDENTIALS');
    });
  });

  it('软删用户（deleted_at 非空）即使密码正确 → 同一错误码（旧 SoftDeletingScope 语义）', async () => {
    await withRollback(async (tx) => {
      await insertAdmin(tx, 'vitest-admin-deleted', { deleted: true });
      const res = await makeService(tx).login({ username: 'vitest-admin-deleted', password: PW });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('ADMIN_INVALID_CREDENTIALS');
    });
  });
});

describe('admin scope 三分支', () => {
  it('绑定 ability-view-all-users 权限（经角色）→ all（复用 dump 权限行 id 43）', async () => {
    await withRollback(async (tx) => {
      const uid = await insertAdmin(tx, 'vitest-admin-all');
      const [perm, role] = await Promise.all([
        tx.admin_permissions.findFirst({
          where: { slug: 'ability-view-all-users' },
          select: { id: true },
        }),
        tx.admin_roles.create({
          data: { name: 'vitest-view-all-role', slug: 'vitest_view_all_role' },
          select: { id: true },
        }),
      ]);
      expect(perm).not.toBeNull();
      await tx.admin_role_permissions.create({
        data: { role_id: role.id, permission_id: perm!.id },
      });
      await tx.admin_role_users.create({ data: { role_id: role.id, user_id: BigInt(uid) } });

      const res = await makeService(tx).resolveScope(uid);
      expect(res).toEqual({ ok: true, value: { kind: 'all' } });
    });
  });

  it('business_manager=["G","I"] 无权限 → flags', async () => {
    await withRollback(async (tx) => {
      const uid = await insertAdmin(tx, 'vitest-admin-flags', { businessManager: '["G","I"]' });
      const res = await makeService(tx).resolveScope(uid);
      expect(res).toEqual({ ok: true, value: { kind: 'flags', flags: ['G', 'I'] } });
    });
  });

  it('business_manager 空串（旧 cast 脏数据）→ none', async () => {
    await withRollback(async (tx) => {
      const uid = await insertAdmin(tx, 'vitest-admin-empty', { businessManager: '' });
      const res = await makeService(tx).resolveScope(uid);
      expect(res).toEqual({ ok: true, value: { kind: 'none' } });
    });
  });

  it('business_manager 非法 JSON → 防御解析为空集 → none', async () => {
    await withRollback(async (tx) => {
      const uid = await insertAdmin(tx, 'vitest-admin-badjson', { businessManager: '{not-json' });
      const res = await makeService(tx).resolveScope(uid);
      expect(res).toEqual({ ok: true, value: { kind: 'none' } });
    });
  });
});
