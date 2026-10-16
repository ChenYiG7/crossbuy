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
}

export class MemberServiceImpl implements MemberService {
  readonly domain = 'member' as const;

  constructor(protected readonly repository: MemberRepository) {}
}
