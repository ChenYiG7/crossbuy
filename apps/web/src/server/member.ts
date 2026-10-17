import {
  deriveOssFullHost,
  InMemoryLoginRateLimiter,
  Md5PasswordVerifier,
  MemberRepository,
  MemberServiceImpl,
  type MemberService,
} from '@crossbuy/domain-member';
import { getWebConfig } from '@/config';
import { MemberTokenVerifier } from '../auth/member-verifier';

/**
 * 组合根（apps/web 唯一装配处）：域实现 + 端口实现在这里接线，
 * 路由/页面只拿接口，不关心后面是 MD5 还是 argon2id、内存限流还是 Redis。
 *
 * 进程内单例（Next dev 的模块热替换会重建，无状态泄漏风险；
 * InMemoryLoginRateLimiter 的窗口状态随之重建——多实例部署换 Redis，见端口注释）。
 */
let memberService: MemberService | null = null;
let memberVerifier: MemberTokenVerifier | null = null;

export function getMemberService(): MemberService {
  memberService ??= new MemberServiceImpl(
    new MemberRepository(),
    new Md5PasswordVerifier(),
    new InMemoryLoginRateLimiter(),
    // 头像怪癖环境值（旧 ossFullHost() 推导 + OSS_CDN_URL，见 avatar.ts）
    {
      ossFullHost: deriveOssFullHost(
        getWebConfig().OSS_BUCKET,
        getWebConfig().OSS_INTERNAL_ENDPOINT,
      ),
      ossCdnUrl: getWebConfig().OSS_CDN_URL ?? '',
    },
  );
  return memberService;
}

export function getMemberVerifier(): MemberTokenVerifier {
  memberVerifier ??= new MemberTokenVerifier();
  return memberVerifier;
}
