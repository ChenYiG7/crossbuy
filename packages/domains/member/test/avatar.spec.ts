/**
 * 头像存储怪癖 1:1 复现用例（旧 haiou，只读参考）：
 *
 * 写侧（旧 EditUserInfoMutation）：入库前剥离 ossFullHost() 前缀；
 * 读侧（旧 UserInfoType::resolveAvatarField）：face 以 /user/avatar、/avatar 开头
 * → 补 OSS_CDN_URL 前缀，否则原样。
 *
 * 纯函数部分不连库；DB 往返部分连真实 dump（事务回滚）。
 * 怪癖登记：docs/plans/08 S10。
 */
import { describe, expect, it } from 'vitest';
import { memberPrincipal } from '@crossbuy/auth';
import { deriveOssFullHost, resolveAvatarUrl, stripOssFullHost } from '../src/avatar';
import { MemberRepository } from '../src/repository';
import { InMemoryLoginRateLimiter } from '../src/login-rate-limiter';
import { Md5PasswordVerifier } from '../src/password-verifier';
import { MemberServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

const OSS_FULL_HOST = 'https://test-taotaro-hz.oss-cn-hangzhou-internal.aliyuncs.com';
const OSS_CDN_URL = 'https://test-taotaro-hz.oss-cn-hangzhou.aliyuncs.com';

describe('deriveOssFullHost（旧 Helpers.php:593 推导）', () => {
  it('bucket 插进内部端点域名前缀', () => {
    expect(
      deriveOssFullHost('test-taotaro-hz', 'https://oss-cn-hangzhou-internal.aliyuncs.com'),
    ).toBe(OSS_FULL_HOST);
  });

  it('缺任一 env → 空串（= 不剥离，禁默认值冒充生产配置）', () => {
    expect(deriveOssFullHost(undefined, 'https://oss-cn-hangzhou-internal.aliyuncs.com')).toBe('');
    expect(deriveOssFullHost('bucket', undefined)).toBe('');
    expect(deriveOssFullHost('', '')).toBe('');
  });
});

describe('stripOssFullHost（写侧）', () => {
  it('剥前缀', () => {
    expect(stripOssFullHost(`${OSS_FULL_HOST}/user/avatar/x.jpg`, OSS_FULL_HOST)).toBe(
      '/user/avatar/x.jpg',
    );
  });

  it('非名单主机（accelerate 域名）原样返回——旧系统照存不误，1:1 不「顺手修」', () => {
    const accelerate = 'https://taotaro-hz.oss-accelerate.aliyuncs.com/user/avatar/x.jpg';
    expect(stripOssFullHost(accelerate, OSS_FULL_HOST)).toBe(accelerate);
  });

  it('空配置 = 原样返回', () => {
    expect(stripOssFullHost(`${OSS_FULL_HOST}/user/avatar/x.jpg`, '')).toBe(
      `${OSS_FULL_HOST}/user/avatar/x.jpg`,
    );
  });
});

describe('resolveAvatarUrl（读侧，旧 resolveAvatarField）', () => {
  it('相对 key → CDN URL', () => {
    expect(resolveAvatarUrl('/user/avatar/2024/08/16/x.jpg', OSS_CDN_URL)).toBe(
      `${OSS_CDN_URL}/user/avatar/2024/08/16/x.jpg`,
    );
    expect(resolveAvatarUrl('/avatar/x.jpg', OSS_CDN_URL)).toBe(`${OSS_CDN_URL}/avatar/x.jpg`);
  });

  it('完整 URL 原样返回（不以 key 前缀开头）', () => {
    const full = 'https://taotaro-hz.oss-accelerate.aliyuncs.com/user/avatar/x.jpg';
    expect(resolveAvatarUrl(full, OSS_CDN_URL)).toBe(full);
  });

  it('null / 空 CDN 配置', () => {
    expect(resolveAvatarUrl(null, OSS_CDN_URL)).toBeNull();
    expect(resolveAvatarUrl('/user/avatar/x.jpg', '')).toBe('/user/avatar/x.jpg');
  });
});

describe('头像 DB 往返（写剥前缀 → 读补 CDN）', () => {
  it('完整 URL 入库存相对 key，读出补 CDN', async () => {
    const uid = await withRollback(async (tx) => {
      const [row] = await tx.dg_users.findMany({ select: { uid: true }, take: 1 });
      return row.uid;
    });

    await withRollback(async (tx) => {
      const service = new MemberServiceImpl(
        new MemberRepository(tx),
        new Md5PasswordVerifier(),
        new InMemoryLoginRateLimiter(),
        { ossFullHost: OSS_FULL_HOST, ossCdnUrl: OSS_CDN_URL },
      );
      const res = await service.updateProfile(memberPrincipal(uid), {
        avatar: `${OSS_FULL_HOST}/user/avatar/2025/12/04/x.jpg`,
      });
      expect(res.ok).toBe(true);

      // 库里存的是相对 key（剥离后的形态）
      const raw = await tx.dg_users.findUnique({
        where: { uid },
        select: { face: true },
      });
      expect(raw?.face).toBe('/user/avatar/2025/12/04/x.jpg');

      // 服务层读出补 CDN 前缀
      const profile = await service.getProfile(memberPrincipal(uid));
      expect(profile.ok && profile.value.avatar).toBe(
        `${OSS_CDN_URL}/user/avatar/2025/12/04/x.jpg`,
      );
    });
  });

  it('accelerate 完整 URL 原样入库、原样读出（不在剥离名单）', async () => {
    const uid = await withRollback(async (tx) => {
      const [row] = await tx.dg_users.findMany({ select: { uid: true }, take: 1 });
      return row.uid;
    });

    const accelerate = 'https://taotaro-hz.oss-accelerate.aliyuncs.com/user/avatar/x.jpg';
    await withRollback(async (tx) => {
      const service = new MemberServiceImpl(
        new MemberRepository(tx),
        new Md5PasswordVerifier(),
        new InMemoryLoginRateLimiter(),
        { ossFullHost: OSS_FULL_HOST, ossCdnUrl: OSS_CDN_URL },
      );
      const res = await service.updateProfile(memberPrincipal(uid), { avatar: accelerate });
      expect(res.ok).toBe(true);

      const raw = await tx.dg_users.findUnique({ where: { uid }, select: { face: true } });
      expect(raw?.face).toBe(accelerate); // 照存不误

      const profile = await service.getProfile(memberPrincipal(uid));
      expect(profile.ok && profile.value.avatar).toBe(accelerate); // 不以 / 开头，不补前缀
    });
  });
});
