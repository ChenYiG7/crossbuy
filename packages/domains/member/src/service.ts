import { memberProfileUpdateSchema } from '@crossbuy/contract';
import type { Principal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import type { MemberError } from './errors';
import type { MemberRepository } from './repository';

/**
 * 会员 域服务（docs/04 §3.2：域间唯一调用面，R3 拆分的搬运单元）。
 *
 * - 出入参类型 = @crossbuy/contract（zod 契约），禁 ORM 类型泄漏到契约
 * - 只认 Principal（@crossbuy/auth 抽象），禁 Auth.js/Session 细节（docs/04 §6）
 * - 事务边界在 service；HTTP/推送/通知移出事务（AFTER_COMMIT 或事件后）
 * - 域间禁横向 import：跨域调用走对方 service 接口，跨域反应走 contract 事件
 * - 旧系统对应：Services/Member、Models/User*；R3 归属：CRM（+认证中心的用户资料）
 */
export interface MemberService {
  /** 服务注册判别键（R3 服务注册表用） */
  readonly domain: 'member';

  /**
   * 更新会员资料（旧 `EditUserInfo` 的服务层等价物）。
   * 入参先过 zod 契约：越界枚举（regType=3 / sex=2 / useType=9 / originPackageChoice=2）
   * 属**可预期失败** ⇒ 返回 Result 错误，不抛异常（docs/07）。
   */
  updateProfile(
    principal: Principal,
    patch: unknown,
  ): Promise<Result<void, MemberError>>;
}

export class MemberServiceImpl implements MemberService {
  readonly domain = 'member' as const;

  constructor(protected readonly repository: MemberRepository) {}

  async updateProfile(
    principal: Principal,
    patch: unknown,
  ): Promise<Result<void, MemberError>> {
    const parsed = memberProfileUpdateSchema.safeParse(patch);
    if (!parsed.success) {
      // 首个 issue 的 path 就是违规字段名（旧系统按字段返回 validation key）
      const field = parsed.error.issues[0]?.path.join('.') ?? 'patch';
      return err({
        code: 'MEMBER_PROFILE_INVALID',
        message: `字段 ${field} 校验失败：${parsed.error.issues[0]?.message ?? ''}`,
      });
    }

    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'MEMBER_PRINCIPAL_INVALID', message: 'Principal 非法' });
    }

    await this.repository.updateProfile(uid, parsed.data);
    return ok(undefined);
  }
}
