import crypto from 'node:crypto';
import {
  MEMBER_STATE,
  type AdminScope,
  type AdminUserListItem,
  type AdminUserListQuery,
} from '@crossbuy/contract';
import { legacyPrisma, type LegacyPrisma, type LegacyPrismaClient } from '@crossbuy/db';

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
 * 字段清单与旧 mutation args 一一对应（2026-10-17 补齐公司字段族，共 22 个）。
 */
const PROFILE_COLUMN = {
  regType: 'regtype',
  companyName: 'comname',
  companyNameEng: 'comengname',
  companyManager: 'commanager',
  companyManagerEng: 'commanagereng',
  companyCode: 'compost',
  companyTel: 'comptel',
  companyAddress: 'comaddress',
  companyAddressEng: 'comaddresseng',
  trueName: 'tname',
  sex: 'sex',
  zip: 'zip',
  tel: 'tel',
  address: 'address',
  country: 'country',
  qq: 'qq',
  line: 'line',
  wechat: 'wechat',
  useType: 'usetype',
  preBuyFrequency: 'prebuyfeq',
  preBuyAmount: 'prebuyamt',
  avatar: 'face',
  originPackageChoice: 'origin_package_choice',
} as const;

/** dg_users.update 的 data 类型（从生成的 client 反推，避免手写 any） */
type ProfileUpdateData = Parameters<LegacyPrismaClient['dg_users']['update']>[0]['data'];

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
   * 后台只读用户列表（docs/06 §四-4 admin「用户管理」只读起步）。
   *
   * scope 三分支 1:1 旧 UserController::grid：
   * - all：不加过滤；
   * - flags：memberid LIKE '{flag}%' OR memberid='' OR NULL（**未分组客户所有人可见**，
   *   旧代码 orWhere 空串/NULL 是有意行为，不是遗漏）；
   * - none：service 层短路（不发查询），这里不处理。
   * q/utype/state 是 REST 面新增便利过滤（LIKE/精确），不改旧默认行为（全量 uid 倒序分页）。
   */
  async listForAdmin(
    scope: Exclude<AdminScope, { kind: 'none' }>,
    query: AdminUserListQuery,
  ): Promise<{ items: AdminUserListItem[]; total: number }> {
    const scopeWhere: LegacyPrisma.dg_usersWhereInput =
      scope.kind === 'all'
        ? {}
        : {
            OR: [
              ...scope.flags.map((flag) => ({ memberid: { startsWith: flag } })),
              { memberid: '' },
              { memberid: null },
            ],
          };

    const filterWhere: LegacyPrisma.dg_usersWhereInput = {
      ...(query.q
        ? {
            OR: [
              { uname: { contains: query.q } },
              { tname: { contains: query.q } },
              { email: { contains: query.q } },
              { memberid: { contains: query.q } },
            ],
          }
        : {}),
      ...(query.utype === undefined ? {} : { utype: query.utype }),
      ...(query.state === undefined ? {} : { state: query.state }),
    };

    const where: LegacyPrisma.dg_usersWhereInput = {
      AND: [scopeWhere, filterWhere],
    };

    const [rows, total] = await Promise.all([
      this.db.dg_users.findMany({
        where,
        select: {
          uid: true,
          uname: true,
          tname: true,
          email: true,
          tel: true,
          memberid: true,
          utype: true,
          state: true,
          money: true,
          regtype: true,
        },
        orderBy: { uid: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.db.dg_users.count({ where }),
    ]);

    return {
      total,
      items: rows.map((row) => ({
        uid: row.uid,
        uname: row.uname,
        tname: row.tname,
        email: row.email,
        tel: row.tel,
        memberid: row.memberid,
        utype: row.utype ?? 0,
        state: row.state ?? 0,
        money: String(row.money ?? '0'),
        regtype: row.regtype,
      })),
    };
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

  // ---------------------------------------------------------------------------
  // 收藏（member 域属主旧表 dg_favorite；旧 AddFavorite/DeleteFavorite/ListFavorite
  // + FavoriteController REST 面。⚠ 表无 (uid, goodsurl) 唯一键——旧系统「先查后插」，
  // 并发同 URL 仍可能插出重复行，1:1 复现不「修」，见 docs/plans/08）
  // ---------------------------------------------------------------------------

  /** 读 uname + dfflag（收藏 type 分流用：旧 `$user->dfflag == DF_FLAG_1 ? 3 : 1`，取库里的活值） */
  async getMemberSlim(uid: number): Promise<{ uname: string; dfFlag: boolean } | null> {
    const row = await this.db.dg_users.findUnique({
      where: { uid },
      select: { uname: true, dfflag: true },
    });
    if (!row) return null;
    return { uname: row.uname, dfFlag: (row.dfflag ?? 0) !== 0 };
  }

  /** 重复收藏检查（旧 AddFavoriteMutation：同 uid + goodsurl 已存在即拒） */
  async findFavoriteByGoodsUrl(uid: number, goodsUrl: string): Promise<{ fid: number } | null> {
    return this.db.dg_favorite.findFirst({
      where: { uid, goodsurl: goodsUrl },
      select: { fid: true },
    });
  }

  /**
   * 新增收藏（旧 AddFavoriteMutation 的写入字段 1:1），返回落库行（供服务层直接转契约）。
   * sellerurl/siteurl/marktext 旧 mutation 不写（null 留空）——客户端只传商品快照。
   */
  async createFavorite(input: {
    uid: number;
    uname: string;
    type: number;
    goodsUrl: string;
    goodsName: string;
    goodsPrice: number;
    goodsImg: string | null;
    goodsSeller: string;
    goodsSite: string;
    addtime: number;
  }): Promise<FavoriteRow> {
    return this.db.dg_favorite.create({
      data: {
        uid: input.uid,
        uname: input.uname,
        typeid: 0, // 旧 mutation 字面量（未用上的分类 id 位）
        type: input.type,
        goodsurl: input.goodsUrl,
        goodsname: input.goodsName,
        goodsprice: input.goodsPrice,
        goodsimg: input.goodsImg,
        goodsseller: input.goodsSeller,
        goodssite: input.goodsSite,
        addtime: input.addtime,
      },
      select: FAVORITE_SELECT,
    });
  }

  /**
   * 收藏列表（旧 ListFavoriteQuery + FavoriteController）：
   * - type 过滤**二值语义**：daifaOnly=true → type=3；否则 → type IS NULL OR type != 3
   * - fid 倒序；分页 skip/take + count（旧 REST 控制器同款）
   */
  async listFavorites(
    uid: number,
    opts: { daifaOnly: boolean; skip: number; take: number },
  ): Promise<{ rows: FavoriteRow[]; total: number }> {
    const typeWhere = opts.daifaOnly
      ? { type: FAVORITE_TYPE_DAIFA }
      : { OR: [{ type: null }, { type: { not: FAVORITE_TYPE_DAIFA } }] };
    const where = { uid, ...typeWhere };
    const [rows, total] = await Promise.all([
      this.db.dg_favorite.findMany({
        where,
        orderBy: { fid: 'desc' },
        skip: opts.skip,
        take: opts.take,
        select: FAVORITE_SELECT,
      }),
      this.db.dg_favorite.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * 删除收藏（旧 DeleteFavoriteMutation：where uid = 当前用户 AND fid IN (...)）。
   * **按 uid 收敛**——删别人的 fid 影响行数 0（旧测试 testDeleteFavoriteWithOtherUidFail
   * 锁死该行为：不报「记录存在但属别人」，统一 not_found）。
   */
  async deleteFavorite(uid: number, fid: number): Promise<number> {
    const result = await this.db.dg_favorite.deleteMany({ where: { uid, fid } });
    return result.count;
  }

  // -----------------------------------------------------------------------
  // 1688 物流建档（旧 OrderController::tryGetUser 1:1；webhook 编排经 service 接口）
  // -----------------------------------------------------------------------

  /**
   * 会员金额因子（旧 $user 的 dfflag/dffee/utype；购物车金额/服务费计算用）。
   * dg_users 属主读口的窄投影——跨域消费走 order 域的 MemberFactorsPort。
   */
  async getMoneyFactors(
    uid: number,
  ): Promise<{ isDf: boolean; dffee: number; utype: number; uname: string | null } | null> {
    const row = await this.db.dg_users.findUnique({
      where: { uid },
      // uname：加购链路 `Cart::create` 的冗余列来源（旧 `$user->uname`，见 docs/plans/08 S37 同族）
      select: { dfflag: true, dffee: true, utype: true, uname: true },
    });
    if (!row) return null;
    // dffee 列是 Decimal（金额单入口纪律：读入即 number 化的窄投影在此收口）
    return {
      isDf: (row.dfflag ?? 0) === 1,
      dffee: Number(row.dffee ?? 0),
      utype: row.utype ?? 0,
      uname: row.uname ?? null,
    };
  }

  /** appid + openid 查 oauth 绑定（旧 OauthLogin::with(['user'])->where(appid)->where(openid)->first()） */
  async findOauthLogin(
    appid: string,
    openid: string,
  ): Promise<{ uid: number; uname: string; memberid: string | null; email: string | null } | null> {
    // 旧库无外键 → Prisma 无关系字段（S19 同源），with(['user']) 拆两步查
    const login = await this.db.v2_oauth_login.findFirst({
      where: { appid, openid, deleted_at: null },
      select: { uid: true },
    });
    if (!login) return null;
    const user = await this.db.dg_users.findUnique({
      where: { uid: login.uid },
      select: { uid: true, uname: true, memberid: true, email: true },
    });
    return user;
  }

  /** uname 撞名检查（旧 User::where('uname')->first()） */
  async unameExists(uname: string): Promise<boolean> {
    const row = await this.db.dg_users.findFirst({ where: { uname }, select: { uid: true } });
    return row !== null;
  }

  /** 只读：按 uid 取会员邮箱（下单成功邮件收件人解析用；web 组合根在入队前调用，worker 不再反向依赖 member 域） */
  async findEmailByUid(uid: number): Promise<string | null> {
    const row = await this.db.dg_users.findFirst({ where: { uid }, select: { email: true } });
    return row?.email ?? null;
  }

  /**
   * 建档用户 + oauth 绑定（旧 tryGetUser 的 User::create + OauthLogin::create 1:1）。
   * ⚠ card 生产 NOT NULL 无默认（非严格模式落 ''）——显式补 '' 等价；memberid 留 NULL
   * （旧 TODO「分配 memberId」至今未实现）；password = md5(随机+时间)（旧 Str::random().time()）。
   * 同一事务：用户与 oauth 绑定原子。
   */
  async createOauthUser(
    input: {
      appid: string;
      openid: string;
      uname: string;
      tel: string | null;
    },
    tx?: LegacyPrisma.TransactionClient,
  ): Promise<{ uid: number; uname: string; memberid: string | null; email: string | null }> {
    // tx 透传（Prisma 禁嵌套事务；测试复用外层 rollback 事务）
    const run = async (client: LegacyPrisma.TransactionClient) => {
      const row = await client.dg_users.create({
        data: {
          uname: input.uname,
          password: createMd5(`${Math.random()}${Date.now()}`),
          card: '',
          tel: input.tel,
          state: 1,
          usetype: 5,
          validity: 0,
        },
        select: { uid: true, uname: true, memberid: true, email: true },
      });
      await client!.v2_oauth_login.create({
        data: { appid: input.appid, openid: input.openid, uid: row.uid },
      });
      return row;
    };
    // tx 显式透传 / repository 绑定 tx 客户端（无 $transaction）= 调用方持事务边界直跑；
    // 绑定 db 单例 = 自起事务
    if (tx) return run(tx);
    if (typeof (this.db as { $transaction?: unknown }).$transaction !== 'function') {
      return run(this.db as LegacyPrisma.TransactionClient);
    }
    return this.db.$transaction(run);
  }
}

/** 旧 `App\Models\Favorite::TYPE_DAIFA`（3 = 一件代发；DAIGOU=1） */
const FAVORITE_TYPE_DAIFA = 3;

/** 收藏行查询列（显式 select，禁 select * 把 sellerurl/siteurl/marktext 等无关列带出） */
const FAVORITE_SELECT = {
  fid: true,
  uid: true,
  uname: true,
  typeid: true,
  type: true,
  goodsurl: true,
  goodsname: true,
  goodsprice: true,
  goodsimg: true,
  goodsseller: true,
  sellerurl: true,
  goodssite: true,
  siteurl: true,
  addtime: true,
} as const;

/** 收藏行（repository 出口类型；列名保持旧库原样，解释权在 service） */
export interface FavoriteRow {
  fid: number;
  uid: number | null;
  uname: string;
  typeid: number;
  type: number | null;
  goodsurl: string;
  goodsname: string;
  goodsprice: number;
  goodsimg: string | null;
  goodsseller: string | null;
  sellerurl: string | null;
  goodssite: string | null;
  siteurl: string | null;
  addtime: number | null;
}

/** md5 十六进制（旧密码格式写入专用；验证走 password-verifier 端口） */
function createMd5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}
