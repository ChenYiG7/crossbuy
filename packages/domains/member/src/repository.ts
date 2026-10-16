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
}
