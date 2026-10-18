import type {
  AlibabaOrderDetailPayload,
  AlibabaSdkCredentials,
  AlibabaSdkResult,
} from './alibaba-sdk';
import { AlibabaSdkClient } from './alibaba-sdk';

/**
 * 1688 SDK 的**组合根接入面**（旧 `PlatformSubAccount::getAlibabaSdkByTradeId` /
 * `Alibaba::getOauthTokenByAccount` 的语义收敛，purchase 域对外端口）。
 *
 * 凭证选组（旧 `getAlibabaSdk`/`getInitParamBySubAccount` 1:1）：
 * - 订单 tid → `v2_order_auto_created` 行（order 域属主表，组合根注入查询端口）→
 *   `platform_sub_account_id` > 0 → 子账号行 → username 前缀选组；
 *   autoCreated 无行 / 子账号无名中无前缀 ⇒ **默认主组**（旧 `getAlibabaSdk()` 无参路径）。
 * - 环境账密：主 = `ALIBABA_FENXIAO_{APPID,APPKEY,TOKEN}`；HK = `{_HK_}`；FRS = 主
 *   appid/appkey + `{_FRS_TOKEN}`。**值一律运行时从 env 读，不落代码/文档。**
 * - ★ 实例 token = env 组 token（旧 `getAlibabaSdk($memberId)` 的 `$params` 三件套），
 *   **不读 `v2_platform_sub_account.token`**（那是 `getInitParamByMemberId` 路径，建单面
 *   getOauthTokenByAccount 才用）；member_id 在 getAlibabaSdkByTradeId 里只用于选组。
 *
 * 轮换边界（旧 `getOrderDetail` 实测）：PEMISSION_ERROR 换的是**实例内 token**，
 * appid/appkey 恒为实例初始化值；换序判定「当前 token 是哪个 env」→ 主→HK→FRS→主
 * 单跳。HK 组被选中（订单建在和田账号）时实例 appid/appkey = HK 值、换出的 token 是
 * FRS/主 env 值——**旧行为就这样**（可能换了个 appid 调用），1:1 不修。
 */

/** 旧 `getAlibabaSdk()` 三组 env 键名对应（值运行时读） */
export const ALIBABA_ENV_KEYS = {
  MAIN: {
    appid: 'ALIBABA_FENXIAO_APPID',
    appkey: 'ALIBABA_FENXIAO_APPKEY',
    token: 'ALIBABA_FENXIAO_TOKEN',
  },
  HK: {
    appid: 'ALIBABA_FENXIAO_HK_APPID',
    appkey: 'ALIBABA_FENXIAO_HK_APPKEY',
    token: 'ALIBABA_FENXIAO_HK_TOKEN',
  },
  /** 旧 `$apps` 数组：飞入时代hho = 主组 appid/appkey + FRS token */
  FRS: {
    appid: 'ALIBABA_FENXIAO_APPID',
    appkey: 'ALIBABA_FENXIAO_APPKEY',
    token: 'ALIBABA_FENXIAO_FRS_TOKEN',
  },
} as const;

export interface AlibabaAccessDeps {
  /**
   * 旧 `OrderAutoCreated::where(platform_trade_id,(string)$tradeId)->where(type,1)
   *   ->where(platform_sub_account_id,>0)->first()` 的 platform_sub_account_id。
   * `v2_order_auto_created` 属主 = order 域 ⇒ 端口注入（域间禁横向 import）。
   */
  findAutoCreatedSubAccountId(tradeId: string): Promise<number | null>;
  /** 子账号行（purchase 自有属主表 `v2_platform_sub_account`） */
  findSubAccountById(
    id: number,
  ): Promise<{ username: string; member_id: string; token: string | null } | null>;
  /** 旧 `getOauthTokenByAccount` 的本地缓存行（username 精确匹配 + type=alibaba） */
  findSubAccountByUsername(
    username: string,
  ): Promise<{ id: number; username: string; token: string | null } | null>;
  /** 旧 updateOrCreate 的 token 回表 */
  upsertSubAccountToken(username: string, accessToken: string): Promise<void>;
  /** env 读取（测试注入；生产 = process.env） */
  envGet(key: string): string | undefined;
}

export interface AlibabaAccessService {
  readonly domain: 'purchase';

  /**
   * 旧 `getAlibabaSdkByTradeId` + getOrderDetail 的 PEMISSION_ERROR 单跳轮换展开。
   * 链[0] = 订单所属账号组（或默认主组）**完整凭证**；链[1..] = 同 appid/appkey 下
   * 换主/HK/FRS env token 的候选（getOrderDetail 只消费[0]与[1]，一次即止——1:1）。
   * 空链 = env 未配置（调用方按旧 !isSuccess 分支处理）。
   */
  getCredentialsByTradeId(tradeId: string): Promise<AlibabaSdkCredentials[]>;

  /** 旧 `Alibaba::getOrderDetail` 主路径（chrome 回传 / webhook-1688 支付面共用） */
  getOrderDetail(tradeId: string): Promise<AlibabaSdkResult<AlibabaOrderDetailPayload>>;

  /** 旧 `Alibaba::getOauthTokenByAccount`（建单面 TODO(#18)③ 的 token 解析面，R1 已备） */
  getOauthTokenByAccount(
    account: string,
  ): Promise<AlibabaSdkResult<{ token: string; from: 0 | 1 | 2 }>>;
}

export class AlibabaAccessServiceImpl implements AlibabaAccessService {
  readonly domain = 'purchase' as const;

  constructor(
    private readonly deps: AlibabaAccessDeps,
    private readonly client: AlibabaSdkClient = new AlibabaSdkClient(),
  ) {}

  // -----------------------------------------------------------------------
  // 凭证选组
  // -----------------------------------------------------------------------

  /** 旧 `getInitParamBySubAccount`：username 前缀 → 三件 env 键名（无前缀命中 = []） */
  private static envKeysByUsername(username: string): [string, string, string] | null {
    if (username.startsWith('和田商贸香港有限公司')) {
      return [ALIBABA_ENV_KEYS.HK.appid, ALIBABA_ENV_KEYS.HK.appkey, ALIBABA_ENV_KEYS.HK.token];
    }
    if (username.startsWith('购霸进出口')) {
      return [
        ALIBABA_ENV_KEYS.MAIN.appid,
        ALIBABA_ENV_KEYS.MAIN.appkey,
        ALIBABA_ENV_KEYS.MAIN.token,
      ];
    }
    if (username.startsWith('飞入时代hho')) {
      return [ALIBABA_ENV_KEYS.FRS.appid, ALIBABA_ENV_KEYS.FRS.appkey, ALIBABA_ENV_KEYS.FRS.token];
    }
    return null;
  }

  private credentialOf(envKeys: [string, string, string]): AlibabaSdkCredentials | null {
    const appid = this.deps.envGet(envKeys[0]);
    const appkey = this.deps.envGet(envKeys[1]);
    const token = this.deps.envGet(envKeys[2]);
    if (!appid || !appkey || !token) return null; // 任一缺失 = 该组不可用
    return { appid, appkey, token };
  }

  /** 主组三件 env 键名 */
  private static mainKeys(): [string, string, string] {
    return [ALIBABA_ENV_KEYS.MAIN.appid, ALIBABA_ENV_KEYS.MAIN.appkey, ALIBABA_ENV_KEYS.MAIN.token];
  }

  getCredentialsByTradeId(tradeId: string): Promise<AlibabaSdkCredentials[]> {
    return this.resolveChainFor(tradeId, null);
  }

  /**
   * 链构造核心（旧 getAlibabaSdkByTradeId + 实例内换 token 的展开）。
   * `baseOverride` 非空 ⇒ 首项 token 用它（建单面：`$sdk->sdkInitParam['token'] = $token`）。
   */
  private async resolveChainFor(
    tradeId: string,
    baseOverride: string | null,
  ): Promise<AlibabaSdkCredentials[]> {
    let appIdKey: string = ALIBABA_ENV_KEYS.MAIN.appid;
    let appKeyKey: string = ALIBABA_ENV_KEYS.MAIN.appkey;
    let baseToken: string | null = null;

    const subAccountId = await this.deps.findAutoCreatedSubAccountId(tradeId);
    if (subAccountId !== null && subAccountId > 0) {
      const sub = await this.deps.findSubAccountById(subAccountId);
      if (sub) {
        const keys = AlibabaAccessServiceImpl.envKeysByUsername(sub.username);
        if (keys !== null) {
          appIdKey = keys[0]; // appid 可能随组不同（HK）
          appKeyKey = keys[1];
          baseToken = this.deps.envGet(keys[2]) ?? null; // 实例 token = env 组 token
        }
      }
    }
    baseToken = baseOverride ?? baseToken ?? this.deps.envGet(ALIBABA_ENV_KEYS.MAIN.token) ?? null;

    const appid = this.deps.envGet(appIdKey);
    const appkey = this.deps.envGet(appKeyKey);
    if (!appid || !appkey || !baseToken) return [];

    // 轮换候选：同 appid/appkey + 三个 env token（剔除首项用的那个）。
    // 链上顺序 = 主→HK→FRS（旧换序 if/elseif 判定顺序，1:1）。
    const allTokens = [
      this.deps.envGet(ALIBABA_ENV_KEYS.MAIN.token),
      this.deps.envGet(ALIBABA_ENV_KEYS.HK.token),
      this.deps.envGet(ALIBABA_ENV_KEYS.FRS.token),
    ].filter((t): t is string => !!t && t !== baseToken);

    const chain: AlibabaSdkCredentials[] = [{ appid, appkey, token: baseToken }];
    for (const t of allTokens) chain.push({ appid, appkey, token: t });
    return chain;
  }

  // -----------------------------------------------------------------------
  // 业务入口
  // -----------------------------------------------------------------------

  async getOrderDetail(tradeId: string): Promise<AlibabaSdkResult<AlibabaOrderDetailPayload>> {
    const chain = await this.getCredentialsByTradeId(tradeId);
    if (chain.length === 0) {
      // 旧 env 缺失时实例照样创建 → 签名无效 → 平台回错误 → !isSuccess 分支；
      // 空链等价该失败信封（msg 拼法与 failEnvelope 一致）。
      return {
        code: 40000,
        msg: '获取订单信息失败，错误原因：',
        data: { error_code: 40002 },
      };
    }
    return this.client.getOrderDetail(tradeId, chain);
  }

  async getOauthTokenByAccount(
    account: string,
  ): Promise<AlibabaSdkResult<{ token: string; from: 0 | 1 | 2 }>> {
    // 旧：默认 sdk 实例（主组）+ 本地 token 缓存查 v2_platform_sub_account
    const sub = await this.deps.findSubAccountByUsername(account);
    const cached = sub !== null && sub.token !== null ? parseAccessToken(sub.token) : null;

    const fallback = this.credentialOf(AlibabaAccessServiceImpl.mainKeys());
    if (fallback === null) {
      // env 未配置：旧 getOauthTokenByAccount 仍在（token=null）会发请求然后错误信封；
      // 空凭证等价失败直达（建单面 `您指定的子账号没有下单权限` 上游文案保留）。
      return { code: 40000, msg: '您指定的子账号没有下单权限，请联系管理员处理。' };
    }

    return this.client.getOauthTokenByAccount(
      account,
      {
        cachedToken: cached,
        saveToken: (accessToken) => this.deps.upsertSubAccountToken(account, accessToken),
      },
      fallback,
    );
  }
}

/** 旧 `$subAccount->token` cast array：JSON 串 → `{accessToken}`；坏 JSON = null */
function parseAccessToken(raw: string): string | null {
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
      const token = (decoded as Record<string, unknown>)['accessToken'];
      return typeof token === 'string' && token !== '' ? token : null;
    }
    return null;
  } catch {
    return null;
  }
}
