import {
  MEMBER_STATE,
  memberLoginSchema,
  memberProfileUpdateSchema,
  type MemberProfile,
} from '@crossbuy/contract';
import type { Principal } from '@crossbuy/auth';
import { err, ok, type Result } from '@crossbuy/utils';
import { money } from '@crossbuy/utils';
import { resolveAvatarUrl, stripOssFullHost } from './avatar';
import type { MemberError } from './errors';
import type { MemberAuthRecord, MemberProfileRow, MemberRepository } from './repository';
import type { LoginRateLimiter } from './login-rate-limiter';
import type { PasswordVerifier } from './password-verifier';

/** 旧系统 ORDER_UNENABLE（User.php 常量，0 = 已锁定） */
const ORDER_UNENABLE = 0;

/** 登录成功产物：uid/isDf 供端上签发会话；profile 直接作响应体（旧系统登录后另查 getUserInfo） */
export interface MemberLoginOutcome {
  uid: number;
  isDf: boolean;
  profile: MemberProfile;
}

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

  /**
   * 登录（旧 `LoginMutation` 的规则复现，REST 入参）：
   * 限流 → 账号查找（邮箱/uname）→ MD5 校验 → state 三闸 → 登录限制检查 → 落 logintime。
   * 会话签发（JWT/cookie）在端上完成——域服务不碰传输层（docs/04 §6）。
   */
  login(input: unknown): Promise<Result<MemberLoginOutcome, MemberError>>;

  /** 读取「我」的资料（旧 getUserInfo 的 dg_users 部分；跨域字段随属主域补齐） */
  getProfile(principal: Principal): Promise<Result<MemberProfile, MemberError>>;
}

export class MemberServiceImpl implements MemberService {
  readonly domain = 'member' as const;

  /**
   * @param oss ossFullHost / ossCdnUrl —— 头像存储怪癖的环境相关值（旧
   *   EditUserInfoMutation 剥离前缀 + UserInfoType::resolveAvatarField 补前缀，
   *   见 avatar.ts 与 docs/plans/08 S10）。空串 = 不剥离/不补（开发期默认）。
   */
  constructor(
    protected readonly repository: MemberRepository,
    protected readonly passwordVerifier: PasswordVerifier,
    protected readonly rateLimiter: LoginRateLimiter,
    protected readonly oss: { ossFullHost?: string; ossCdnUrl?: string } = {},
  ) {}

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

    // 头像存储怪癖：入库前剥离 ossFullHost 前缀（旧 EditUserInfoMutation，
    // 1:1 复现；空配置 = 不剥离，禁把「没配 env」静默变成「改数据」）
    const data =
      parsed.data.avatar !== undefined
        ? { ...parsed.data, avatar: stripOssFullHost(parsed.data.avatar, this.oss.ossFullHost ?? '') }
        : parsed.data;

    await this.repository.updateProfile(uid, data);
    return ok(undefined);
  }

  async login(input: unknown): Promise<Result<MemberLoginOutcome, MemberError>> {
    const parsed = memberLoginSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') ?? 'input';
      return err({
        code: 'MEMBER_LOGIN_INVALID',
        message: `字段 ${field} 校验失败：${parsed.error.issues[0]?.message ?? ''}`,
      });
    }
    const { username, password } = parsed.data;

    // 1. 限流（旧代码第一道闸；所有尝试都计数，含成功）
    if (!this.rateLimiter.attempt(`login-attempts-${username}`)) {
      return err({ code: 'MEMBER_LOGIN_RATE_LIMITED', message: '尝试次数过多，请稍后再试' });
    }

    // 2. 账号查找 + 口令校验。未找到与密码错误**同一错误码**——禁用户枚举（旧系统同样处理）
    const record = await this.repository.findByLoginId(username);
    if (!record || !this.passwordVerifier.verify(password, record.password)) {
      return err({ code: 'MEMBER_LOGIN_FAILED', message: '账号或密码错误' });
    }

    // 3. state 三闸（旧 LoginMutation 顺序，逐条对应旧错误消息）
    const stateGate = this.checkStateGate(record);
    if (stateGate) return err(stateGate);

    // 4. 登录限制检查（旧 checkUserLoginLimit，含改库副作用）
    if (await this.checkLoginLimit(record)) {
      return err({ code: 'MEMBER_LOGIN_RESTRICTED', message: '账号已被限制登录' });
    }

    // 5. 落 logintime（unix epoch 秒）
    await this.repository.touchLogintime(record.uid, Math.floor(Date.now() / 1000));

    // 6. 组装（profile 直接作响应体，免端上二次查询）
    const row = await this.repository.findMemberProfile(record.uid);
    if (!row) {
      // 理论上不可达（刚查到）；真出现说明并发删号，按未找到处理
      return err({ code: 'MEMBER_NOT_FOUND', message: '会员不存在' });
    }
    return ok({
      uid: record.uid,
      isDf: (record.dfflag ?? 0) !== 0,
      profile: this.toProfile(row),
    });
  }

  async getProfile(principal: Principal): Promise<Result<MemberProfile, MemberError>> {
    if (principal.kind !== 'member') {
      return err({ code: 'MEMBER_PRINCIPAL_INVALID', message: '非会员主体' });
    }
    const uid = Number(principal.subject);
    if (!Number.isInteger(uid) || uid <= 0) {
      return err({ code: 'MEMBER_PRINCIPAL_INVALID', message: 'Principal 非法' });
    }
    const row = await this.repository.findMemberProfile(uid);
    if (!row) return err({ code: 'MEMBER_NOT_FOUND', message: '会员不存在' });
    return ok(this.toProfile(row));
  }

  /** 旧 LoginMutation 的 state 三闸：0 未審査 / -1 审核失败 / 3 使用禁止 */
  private checkStateGate(record: MemberAuthRecord): MemberError | null {
    switch (record.state) {
      case MEMBER_STATE.PENDING_REVIEW:
        return { code: 'MEMBER_ACCOUNT_PENDING_REVIEW', message: '账号待审核' };
      case MEMBER_STATE.REVIEW_FAILED:
        return { code: 'MEMBER_ACCOUNT_REVIEW_FAILED', message: '账号审核未通过' };
      case MEMBER_STATE.FORBIDDEN:
        return { code: 'MEMBER_ACCOUNT_FORBIDDEN', message: '账号已被禁用' };
      default:
        return null;
    }
  }

  /**
   * 旧 `User::checkUserLoginLimit()` 复现：
   * - state=4（登录限制）→ 直接拒
   * - orderenable=0 且 stoptime 非空且早于 7 天前 → **先改库**（state=4/orderenable=0）再拒
   * - 其余放行。旧代码中「3 个月不活跃」两条规则与白名单均为注释状态——保持注释状态
   */
  private async checkLoginLimit(record: MemberAuthRecord): Promise<boolean> {
    if (record.state === MEMBER_STATE.LOGIN_RESTRICTED) return true;
    if (record.orderenable === ORDER_UNENABLE && record.stoptime != null && record.stoptime > 0) {
      const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
      if (record.stoptime < sevenDaysAgo) {
        await this.repository.applyLoginLimit(record.uid);
        return true;
      }
    }
    return false;
  }

  /** 资料行 → 契约读模型（money 走 utils/money 单入口序列化；reg_extra JSON 解析） */
  protected toProfile(row: MemberProfileRow): MemberProfile {
    return {
      uid: row.uid,
      uname: row.uname,
      email: row.email,
      regType: row.regtype,
      companyName: row.comname,
      companyNameEng: row.comengname,
      companyManager: row.commanager,
      companyManagerEng: row.commanagereng,
      companyCode: row.compost,
      companyTel: row.comptel,
      companyAddress: row.comaddress,
      companyAddressEng: row.comaddresseng,
      trueName: row.tname,
      sex: row.sex,
      zip: row.zip,
      tel: row.tel,
      address: row.address,
      country: row.country,
      qq: row.qq,
      line: row.line,
      wechat: row.wechat,
      useType: row.usetype,
      preBuyFrequency: row.prebuyfeq,
      preBuyAmount: row.prebuyamt,
      money: money(row.money?.toString() ?? '0'),
      dfFlag: (row.dfflag ?? 0) !== 0,
      // 头像读侧：相对 key → CDN URL（旧 resolveAvatarField，1:1 复现）
      avatar: resolveAvatarUrl(row.face, this.oss.ossCdnUrl ?? ''),
      useInquiry: parseUseInquiry(row.reg_extra),
      originPackageChoice: row.origin_package_choice,
    };
  }
}

/**
 * reg_extra JSON → useInquiry 布尔（旧系统 `json_encode(['useInquiry' => true])` 存储）。
 * 容错：null / 非法 JSON / 缺键 / 非 true 值一律 false（旧代码 `?? false` 的等价物）。
 */
export function parseUseInquiry(regExtra: string | null): boolean {
  if (!regExtra) return false;
  try {
    const parsed: unknown = JSON.parse(regExtra);
    if (parsed !== null && typeof parsed === 'object' && 'useInquiry' in parsed) {
      return (parsed as { useInquiry?: unknown }).useInquiry === true;
    }
    return false;
  } catch {
    return false;
  }
}
