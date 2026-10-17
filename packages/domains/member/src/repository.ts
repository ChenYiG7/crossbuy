import { MEMBER_STATE } from '@crossbuy/contract';
import { legacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';

/**
 * 会员 域 repository 防腐层（docs/04 §5 / docs/07）。
 *
 * 本文件是 member 域唯一允许 import @crossbuy/db 的位置——ESLint 边界规则强制，
 * 全仓其他位置 import 即 lint error（守卫有效性由 scripts/boundary-probe.mjs 破坏验证）。
 *
 * 纪律：
 * - 旧表原样读写，禁顺手清理列名；复现怪癖必须 1:1 并登记 docs/plans/08
 * - 时间戳 Asia/Shanghai 语义；金额读入即转 Decimal（utils/money 单入口）
 * - 别域数据禁直连表：跨域读走属主域 service 接口（docs/04 §3.2-1）
 * - 写路径唯一入口 + 状态机 CAS（UPDATE ... WHERE status=from）随域铺开时落
 * - 属主旧表清单见 docs/plans/07-表属主映射.md
 */
/**
 * 资料字段 → 旧表列映射（1:1 复现旧 `EditUserInfoMutation` 的 args alias，禁顺手改名）。
 * 例：`trueName → tname`、`avatar → face`、`useType → usetype`（后者是**枚举不是布尔**，
 * 见 docs/plans/07 §三 tinyint(1) 陷阱）。
 */
const PROFILE_COLUMN = {
  regType: 'regtype',
  companyName: 'comname',
  trueName: 'tname',
  sex: 'sex',
  tel: 'tel',
  address: 'address',
  zip: 'zip',
  country: 'country',
  qq: 'qq',
  useType: 'usetype',
  avatar: 'face',
  originPackageChoice: 'origin_package_choice',
} as const;

/** dg_users.update 的 data 类型（从生成的 client 反推，避免手写 any） */
type ProfileUpdateData = Parameters<
  LegacyPrismaClient['dg_users']['update']
>[0]['data'];

/** 旧系统 ORDER_UNENABLE（User.php 常量，0 = 已锁定） */
const ORDER_UNENABLE = 0;

/**
 * 登录查找结果（窄类型：只有登录判定所需字段）。
 * password 哈希不出本类——校验在 service 层经 PasswordVerifier 端口完成。
 */
export interface MemberAuthRecord {
  uid: number;
  uname: string;
  /** 旧库 MD5 无盐哈希（CHAR(32) hex） */
  password: string;
  email: string | null;
  state: number | null;
  orderenable: number | null;
  /** unix 时间戳（秒）；null/0 = 未锁定 */
  stoptime: number | null;
  dfflag: number | null;
}

/**
 * 会员资料行（findMemberProfile 的显式返回类型）。
 * money 用最小结构类型承载 Prisma Decimal——服务层经 utils/money 单入口转字符串，
 * 避免把 Prisma runtime 类型泄漏进行接口签名（TS2742：推断类型不可移植）。
 */
export interface MemberProfileRow {
  uid: number;
  uname: string;
  email: string | null;
  regtype: number | null;
  comname: string | null;
  comengname: string | null;
  commanager: string | null;
  commanagereng: string | null;
  compost: string | null;
  comptel: string | null;
  comaddress: string | null;
  comaddresseng: string | null;
  tname: string | null;
  sex: number | null;
  zip: string | null;
  tel: string | null;
  address: string | null;
  country: string | null;
  qq: string | null;
  line: string | null;
  wechat: string | null;
  usetype: number | null;
  prebuyfeq: string | null;
  prebuyamt: string | null;
  money: { toString(): string } | null;
  dfflag: number | null;
  face: string | null;
  reg_extra: string | null;
  origin_package_choice: number | null;
}

export class MemberRepository {
  constructor(protected readonly db: LegacyPrismaClient = legacyPrisma) {}

  /**
   * 更新会员资料（旧 EditUserInfo 的写路径）。
   *
   * - 只更新显式传入的字段（undefined = 不改），与旧 mutation 语义一致
   * - 传入事务 client 即参与事务（测试用它做回滚隔离）
   * - 列值原样写入：usetype 存 1..5 的枚举值，不做布尔化
   */
  async updateProfile(
    uid: number,
    patch: Partial<Record<keyof typeof PROFILE_COLUMN, number | string>>,
  ): Promise<void> {
    const data: Record<string, number | string> = {};
    for (const [field, column] of Object.entries(PROFILE_COLUMN)) {
      const value = (patch as Record<string, number | string | undefined>)[field];
      if (value !== undefined) data[column] = value;
    }
    if (Object.keys(data).length === 0) return; // 空 patch 不写库（旧系统亦无副作用）
    await this.db.dg_users.update({
      where: { uid },
      data: data as ProfileUpdateData,
    });
  }

  /** 读取会员资料（测试与读路径共用；返回 null 表示会员不存在） */
  async findProfile(uid: number): Promise<{
    uid: number;
    regtype: number | null;
    sex: number | null;
    usetype: number | null;
    origin_package_choice: number | null;
    tname: string | null;
  } | null> {
    return this.db.dg_users.findUnique({
      where: { uid },
      select: {
        uid: true,
        regtype: true,
        sex: true,
        usetype: true,
        origin_package_choice: true,
        tname: true,
      },
    });
  }

  /**
   * 按登录账号查找会员（旧 LoginMutation 语义）：
   * 入参是合法邮箱 → 匹配 email 列，否则匹配 uname 列（旧 `filter_var(FILTER_VALIDATE_EMAIL)`）。
   *
   * - 大小写不敏感由列 collation（utf8_general_ci）决定，与旧系统一致（客户端不干预）
   * - 邮箱判定用务实正则近似 PHP filter_var（不接受无 TLD 地址等边角格式）
   */
  async findByLoginId(loginId: string): Promise<MemberAuthRecord | null> {
    const byEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId);
    return this.db.dg_users.findFirst({
      where: byEmail ? { email: loginId } : { uname: loginId },
      select: {
        uid: true,
        uname: true,
        password: true,
        email: true,
        state: true,
        orderenable: true,
        stoptime: true,
        dfflag: true,
      },
    });
  }

  /**
   * 读取会员资料全字段（旧 getUserInfo 的 dg_users 部分）。
   * reg_extra 原样带出（JSON 文本），解析在 service 层——repository 不做业务解释。
   */
  async findMemberProfile(uid: number): Promise<MemberProfileRow | null> {
    return this.db.dg_users.findUnique({
      where: { uid },
      select: {
        uid: true,
        uname: true,
        email: true,
        regtype: true,
        comname: true,
        comengname: true,
        commanager: true,
        commanagereng: true,
        compost: true,
        comptel: true,
        comaddress: true,
        comaddresseng: true,
        tname: true,
        sex: true,
        zip: true,
        tel: true,
        address: true,
        country: true,
        qq: true,
        line: true,
        wechat: true,
        usetype: true,
        prebuyfeq: true,
        prebuyamt: true,
        money: true,
        dfflag: true,
        face: true,
        reg_extra: true,
        origin_package_choice: true,
      },
    });
  }

  /** 登录成功落 logintime（旧 LoginMutation：`time()` 写入，unix epoch 秒，UTC） */
  async touchLogintime(uid: number, at: number): Promise<void> {
    await this.db.dg_users.update({ where: { uid }, data: { logintime: at } });
  }

  /**
   * 登录限制落地（旧 `User::checkUserLoginLimit()` 的副作用）：
   * 命中「orderenable=0 且 stoptime 早于 7 天前」时，旧代码**先把用户改成
   * state=4 / orderenable=0 再返回拒绝**——检查即写库，1:1 复现；
   * 该怪癖的收敛方案登记在 docs/plans/08（R2）。
   */
  async applyLoginLimit(uid: number): Promise<void> {
    await this.db.dg_users.update({
      where: { uid },
      data: { state: MEMBER_STATE.LOGIN_RESTRICTED, orderenable: ORDER_UNENABLE },
    });
  }
}
