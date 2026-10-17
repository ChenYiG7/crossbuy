/**
 * M1 翻译 —— 源：旧系统 `tests/Feature/GraphQLTest/Mutations/Member/LoginTest.php`
 * （haiou，只读参考）。
 *
 * 翻译原则（同 M0.9）：测**业务规则**，不测传输层（旧用例是 GraphQL mutation，
 * R1 改 REST + service；captcha/from 参数属传输层，验证码复现另行登记）。
 *
 * 覆盖的旧用例 → 新用例映射：
 *   testLoginFromAppSuccess                          → 成功登录（uname / email 各一条）
 *   testLoginFromPcWithErrorPwd                      → 密码错误
 *   （旧用例没有「用户不存在」——PHP 侧同样返回 login_password_error，这里补一条同码断言）
 *   testLoginFailsWhenUserStateIsRestricted          → state=4 拒绝
 *   testLoginFailsWhenUserIsDisabledAndStoppedOverSevenDays → orderenable=0+stoptime>7d
 *                                                 拒绝 **且用户被改成 state=4/orderenable=0**
 *   testLoginSucceedsWhenLastBalanceChangedOverThreeMonths → 3 个月规则已注释（不再拦截）
 *   testLoginSucceedsWhenUserIsNotRestricted         → 正常用户放行 + logintime 落库
 *   RateLimiter::attempt($key, 5)                    → 同 username 第 6 次被拒（60s 窗口）
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MEMBER_STATE } from '@crossbuy/contract';
import { legacyPrisma } from '@crossbuy/db';
import { InMemoryLoginRateLimiter } from '../src/login-rate-limiter';
import { Md5PasswordVerifier } from '../src/password-verifier';
import { MemberRepository } from '../src/repository';
import { MemberServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

/** 旧 `md5($password)`：Node 侧同算法同结果 */
function md5(raw: string): string {
  return createHash('md5').update(raw, 'utf8').digest('hex');
}

/** 旧 UserFactory + TestCase::createUser 的最小合法行（card/validity 是 NOT NULL 无默认列） */
function testUserRow(overrides: {
  uname: string;
  password?: string;
  state?: number;
  orderenable?: number;
  stoptime?: number | null;
}) {
  return {
    uname: overrides.uname,
    password: overrides.password ?? md5('test'),
    card: 'test',
    validity: 1,
    memberid: 'testmember',
    email: `${overrides.uname}@example.com`,
    state: overrides.state,
    orderenable: overrides.orderenable,
    stoptime: overrides.stoptime,
  };
}

/** 组一个 service（每次新建 ⇒ 限流器状态互不污染） */
function makeService(tx: typeof legacyPrisma) {
  return new MemberServiceImpl(
    new MemberRepository(tx),
    new Md5PasswordVerifier(),
    new InMemoryLoginRateLimiter(),
  );
}


describe('login（旧 PHPUnit LoginTest 翻译）', () => {
  it('成功：uname + 正确密码 → 登录并返回 profile', async () => {
    await withRollback(async (tx) => {
      const created = await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-uname' }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-uname', password: 'test' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.uid).toBe(created.uid);
      expect(res.value.isDf).toBe(false);
      expect(res.value.profile.uname).toBe('vitest-login-uname');
      expect(res.value.profile.email).toBe('vitest-login-uname@example.com');
    });
  });

  it('成功：邮箱亦可登录（旧 filter_var 分支）', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-email' }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({
        username: 'vitest-login-email@example.com',
        password: 'test',
      });
      expect(res.ok).toBe(true);
    });
  });

  it('密码错误 → MEMBER_LOGIN_FAILED（旧 login_password_error）', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-wrongpwd' }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({
        username: 'vitest-login-wrongpwd',
        password: 'wrong',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MEMBER_LOGIN_FAILED');
    });
  });

  it('用户不存在 → 与密码错误**同一错误码**（禁用户枚举，旧系统同样处理）', async () => {
    const res = await makeService(legacyPrisma).login({
      username: 'no-such-user-vitest-xyz',
      password: 'test',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('MEMBER_LOGIN_FAILED');
  });

  it('state=0 未審査 → MEMBER_ACCOUNT_PENDING_REVIEW', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-s0', state: MEMBER_STATE.PENDING_REVIEW }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-s0', password: 'test' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MEMBER_ACCOUNT_PENDING_REVIEW');
    });
  });

  it('state=-1 审核失败 → MEMBER_ACCOUNT_REVIEW_FAILED', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-sfail', state: MEMBER_STATE.REVIEW_FAILED }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-sfail', password: 'test' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MEMBER_ACCOUNT_REVIEW_FAILED');
    });
  });

  it('state=3 使用禁止 → MEMBER_ACCOUNT_FORBIDDEN', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-s3', state: MEMBER_STATE.FORBIDDEN }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-s3', password: 'test' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MEMBER_ACCOUNT_FORBIDDEN');
    });
  });

  it('state=4 登录限制 → MEMBER_LOGIN_RESTRICTED（旧 testLoginFailsWhenUserStateIsRestricted）', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-s4', state: MEMBER_STATE.LOGIN_RESTRICTED }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-s4', password: 'test' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MEMBER_LOGIN_RESTRICTED');
    });
  });

  /**
   * ★ 旧 checkUserLoginLimit 的改库副作用 1:1 复现的锁死用例：
   * orderenable=0 且 stoptime 早于 7 天前 → 拒绝，**且用户行已被改成 state=4/orderenable=0**
   * （旧代码「检查即写库」，R2 收敛前必须保持该行为，见 docs/plans/08）。
   */
  it('orderenable=0 + stoptime 超过 7 天 → 拒绝且用户被改成登录限制态', async () => {
    await withRollback(async (tx) => {
      const created = await tx.dg_users.create({
        data: testUserRow({
          uname: 'vitest-login-stop8d',
          state: MEMBER_STATE.NORMAL,
          orderenable: 0,
          stoptime: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
        }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-stop8d', password: 'test' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('MEMBER_LOGIN_RESTRICTED');

      // 副作用断言：事务内重读，行已被改写（回滚后 dump 不受影响）
      const after = await tx.dg_users.findUnique({
        where: { uid: created.uid },
        select: { state: true, orderenable: true },
      });
      expect(after?.state).toBe(MEMBER_STATE.LOGIN_RESTRICTED);
      expect(after?.orderenable).toBe(0);
    });
  });

  it('orderenable=0 但 stoptime 在 7 天内 → 放行（旧 isBefore(now-7d) 边界）', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({
          uname: 'vitest-login-stop3d',
          state: MEMBER_STATE.NORMAL,
          orderenable: 0,
          stoptime: Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60,
        }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-stop3d', password: 'test' });
      expect(res.ok).toBe(true);
    });
  });

  it('3 个月不活跃规则已不再是登录闸门（旧 testLoginSucceedsWhenLastBalanceChangedOverThreeMonths）', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({
          uname: 'vitest-login-3m',
          state: MEMBER_STATE.NORMAL,
          orderenable: 1,
        }),
        select: { uid: true },
      });
      // last_balance_changed_at 保持默认/空——旧代码里两条 3 个月规则均已注释
      const res = await makeService(tx).login({ username: 'vitest-login-3m', password: 'test' });
      expect(res.ok).toBe(true);
    });
  });

  it('正常用户登录成功 → logintime 落为当前 unix 时间戳', async () => {
    const before = Math.floor(Date.now() / 1000);
    await withRollback(async (tx) => {
      const created = await tx.dg_users.create({
        data: testUserRow({
          uname: 'vitest-login-ok',
          state: MEMBER_STATE.NORMAL,
          orderenable: 1,
        }),
        select: { uid: true },
      });
      const res = await makeService(tx).login({ username: 'vitest-login-ok', password: 'test' });
      expect(res.ok).toBe(true);

      const after = await tx.dg_users.findUnique({
        where: { uid: created.uid },
        select: { logintime: true },
      });
      expect(after?.logintime).not.toBeNull();
      expect(after!.logintime!).toBeGreaterThanOrEqual(before);
      expect(after!.logintime!).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5);
    });
  });

  it('限流：同一 username 第 6 次尝试被拒（旧 RateLimiter::attempt($key, 5)，60s 窗口）', async () => {
    await withRollback(async (tx) => {
      await tx.dg_users.create({
        data: testUserRow({ uname: 'vitest-login-rl' }),
        select: { uid: true },
      });
      const service = makeService(tx);
      // 前 5 次（密码全错）都走正常失败分支
      for (let i = 0; i < 5; i++) {
        const res = await service.login({ username: 'vitest-login-rl', password: 'wrong' });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error.code).toBe('MEMBER_LOGIN_FAILED');
      }
      // 第 6 次——**即使密码正确**也被限流拦在账号查找之前
      const blocked = await service.login({ username: 'vitest-login-rl', password: 'test' });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.code).toBe('MEMBER_LOGIN_RATE_LIMITED');
    });
  });

  it('限流窗口过期后放行（注入时钟，不等真实 60s）', async () => {
    let now = 1_000_000;
    const limiter = new InMemoryLoginRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) expect(limiter.attempt('k')).toBe(true);
    expect(limiter.attempt('k')).toBe(false); // 窗口内第 6 次
    now += 61_000; // 越过 60s 窗口
    expect(limiter.attempt('k')).toBe(true); // 计数已清零
  });

  /**
   * 防写脏回归：以上用例全部包在回滚事务里，跑完 dump 库不应留下任何 vitest- 用户。
   * （真泄漏了这条会红——事务隔离失效比测试失败更严重。）
   */
  it('回归：dump 库无 vitest- 残留用户（事务回滚生效）', async () => {
    const leaked = await legacyPrisma.dg_users.count({ where: { uname: { startsWith: 'vitest-' } } });
    expect(leaked).toBe(0);
  });
});
