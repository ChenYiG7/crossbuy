import { createHmac } from 'node:crypto';

/**
 * 1688 开放平台 SDK 客户端（旧 `App\Libraries\Alibaba.php` 的**订单详情/子账号令牌**子集 1:1）。
 *
 * 放在 purchase 域：`v2_platform_sub_account`（属主 = purchase，docs/plans/07 §四）是
 * 采买子账号池，1688 网关调用（appid/appkey/token）属于采购对接能力。
 *
 * 1:1 锚点（动前先读旧 PHP，禁"顺手修"）：
 * - `makeSign`（Alibaba.php:1054-1072）：`access_token` 并入参数、`_aop_timestamp` = 毫秒、
 *   ksort 后按 `key . value` 拼接 → 签名原文 = `{fullApi}/{appid}` + paramStr
 *   → HMAC-SHA1(appkey) → 大写 hex → 写回 `_aop_signature`。
 * - `execute`（Alibaba.php:1404-1445）：POST 到
 *   `http://gw.open.1688.com/openapi/{fullApi}/{appid}?`（**http**）；form_params；
 *   数组/对象值 `json_encode` 成串、null 剔除；网络异常 → `resp = ['message' =>
 *   '接口超时，请稍后重试！']`、`original = ''`（HTTP 失败不抛、当业务失败）。
 * - `getOrderDetail`（Alibaba.php:1079-1121）：`com.alibaba.trade/alibaba.trade.get.buyerView`、
 *   入参 `webSite='1688'` + `orderId`；取 `resp.result`（PHP `!empty` 判空）；
 *   `errorCode == 'PEMISSION_ERROR'`（弱比较）时 SDK 实例内
 *   换 token **只重试一次**（主→HK→FRS→主）。旧实例换 token 有**状态污染副作用**
 *   （singletonIf 实例的后续调用沿用换后的 token）——本实现凭证不可变，轮换 = 链上跳位，
 *   污染不复现（受益差异，登记 docs/plans/08 S48 备注）。
 * - `getOauthAccount`（Alibaba.php:1486）/`addSubAccount`（:1522）：入参 `is_string` 包数组、
 *   API 分别为 subaccount.auth.list / .add；取 `resp.returnValue`（!empty）；空 → 40000
 *   （msg = `message`/`errorMsg` Arr::get 链）。
 * - `getOauthTokenByAccount`（Alibaba.php:1601-1656）：先查本地
 *   `v2_platform_sub_account.token['accessToken']`（type='alibaba'）——旧外面包 30 分钟
 *   Cache::remember（R1 不复现缓存层，每次直查表；差异登记：查询频率可承受、语义等价）；
 *   未命中 → getOauthAccount → 失败再 addSubAccount → `Arr::first($result['data'])['accessToken']`
 *   / `$result['data'][0]['accessToken']` 取 token → updateOrCreate 回表。
 *   ⚠ addSubAccount 兜底已含；createOrder/markMemo 等建单面方法属 TODO(#18)③，不提前实现。
 *
 * 凭证纪律：appid/appkey/token 一律经入参注入（来源 = env 或账号表，**不落代码不落文档**）。
 */

/** 一组 1688 SDK 凭证（旧 `$sdkInitParam`） */
export interface AlibabaSdkCredentials {
  appid: string;
  appkey: string;
  token: string;
}

/** execute 原始响应（旧 `$data['data']['resp' | 'original']`） */
export interface AlibabaRawResponse {
  resp: Record<string, unknown> | null;
  original: string;
}

/** SDK 业务信封（旧方法返回数组形态） */
export type AlibabaSdkResult<T = unknown> =
  { code: 200; data: T } | { code: 40000; msg?: string; resp?: unknown; data?: unknown };

/** 订单详情 payload（`resp.result`；键随平台返回漂移，取宽形态） */
export interface AlibabaOrderDetailPayload {
  baseInfo?: Record<string, unknown>;
  productItems?: unknown[];
  [key: string]: unknown;
}

/** 接口响应里的子账号授权项（旧 `returnValue[]`；accessToken 为所需键） */
export interface SubAccountAuthItem {
  accessToken?: string;
  [key: string]: unknown;
}

/** 单一 HTTP 端口（测试替换用；生产实现走 fetch） */
export interface AlibabaHttpPort {
  postForm(
    url: string,
    form: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; body: string }>;
}

/**
 * 旧 `(new Client())->post(..., ['timeout' => 10, 'verify' => false, 'http_errors' => false])`。
 * 语义分界（必须与旧 Guzzle 对齐）：HTTP 层拿到响应（哪怕 4xx/5xx —— http_errors=false）
 * 返回 `{ok:true, body}`；**网络/超时异常 = throw**（由 execute 的 catch 转「接口超时」
 * 信封，1:1 旧 catch 块）。ok 布尔只用于「响应体能否 JSON 化」前的健壮性，不承担
 * 网络失败语义。
 */
export const DefaultAlibabaHttp: AlibabaHttpPort = {
  async postForm(url, form, timeoutMs) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, body: await res.text() };
  },
};

export interface AlibabaSdkOptions {
  /** HTTP 端口（默认 fetch；测试注入假实现） */
  http?: AlibabaHttpPort;
  /** 注入时钟（默认真实时间；`_aop_timestamp` 毫秒） */
  now?: () => Date;
}

const GATEWAY = 'http://gw.open.1688.com/openapi';
const HTTP_TIMEOUT_MS = 10_000;

export class AlibabaSdkClient {
  private readonly http: AlibabaHttpPort;
  private readonly now: () => Date;

  constructor(options: AlibabaSdkOptions = {}) {
    this.http = options.http ?? DefaultAlibabaHttp;
    this.now = options.now ?? (() => new Date());
  }

  // -----------------------------------------------------------------------
  // makeSign（旧 makeSign 1:1）
  // -----------------------------------------------------------------------

  /** 旧 makeSign in-place 改两键；这里纯函数化：返回签名与**含签名的完整 form** */
  makeSign(
    params: Record<string, string>,
    /** 签名原文里的 api 段（execute 路径 = 已带 param2/1/ 前缀） */
    fullApi: string,
    credentials: AlibabaSdkCredentials,
  ): { sign: string; form: Record<string, string> } {
    const timestamp = String(this.now().getTime()); // 旧 `time() * 1000`
    const form: Record<string, string> = { ...params };
    form['access_token'] = credentials.token;
    form['_aop_timestamp'] = timestamp;

    // 旧 ksort = PHP 字节序；JS localeCompare 受 locale 影响 ⇒ 按 code unit 排
    const keys = Object.keys(form).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    let paramStr = '';
    for (const k of keys) paramStr += k + form[k]!;

    const signBase = `${fullApi}/${credentials.appid}${paramStr}`;
    const sign = createHmac('sha1', credentials.appkey)
      .update(signBase)
      .digest('hex')
      .toUpperCase();
    form['_aop_signature'] = sign;
    return { sign, form };
  }

  // -----------------------------------------------------------------------
  // execute（旧 execute 1:1）
  // -----------------------------------------------------------------------

  /** 旧 execute 值预处理：数组/对象 json_encode；null 剔除；bool 转 PHP 串 */
  private static toFormValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? '1' : ''; // PHP bool→string
    return String(value);
  }

  async execute(
    api: string,
    params: Record<string, unknown>,
    credentials: AlibabaSdkCredentials,
  ): Promise<AlibabaRawResponse> {
    const fullApi = `param2/1/${api}`;
    const form: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) {
      const s = AlibabaSdkClient.toFormValue(v);
      if (s !== null) form[k] = s;
    }

    const { form: signedForm } = this.makeSign(form, fullApi, credentials);
    const url = `${GATEWAY}/${fullApi}/${credentials.appid}?`;

    try {
      const res = await this.http.postForm(url, signedForm, HTTP_TIMEOUT_MS);
      let parsed: unknown = null;
      if (res.ok && res.body !== '') {
        try {
          parsed = JSON.parse(res.body) as unknown;
        } catch {
          parsed = null; // 旧 json_decode 失败 → null 同义
        }
      }
      return {
        resp: (parsed !== null && typeof parsed === 'object' ? parsed : null) as Record<
          string,
          unknown
        > | null,
        original: res.ok ? res.body : '',
      };
    } catch {
      // 旧 catch：logMessage + resp = ['message' => '接口超时，请稍后重试！']
      return { resp: { message: '接口超时，请稍后重试！' }, original: '' };
    }
  }

  // -----------------------------------------------------------------------
  // getOrderDetail（旧 getOrderDetail 1:1）
  // -----------------------------------------------------------------------

  /**
   * 旧 `Alibaba::getOrderDetail($orderId, $extra)`。
   *
   * @param credentialsChain 旧「SDK 实例 + errorCode=PEMISSION_ERROR 时在实例内换 token
   *   （主→HK→FRS→主）重试**一次**」的展开形态：调用方按主→HK→FRS 投入组；
   *   权限错误时跳链上**下一个**凭证重试一次；非权限错误直接落信封（不轮换）。
   * @returns 200 = `result`；40000 = 旧错误信封（msg 拼接 1:1）。
   */
  async getOrderDetail(
    orderId: string,
    credentialsChain: ReadonlyArray<AlibabaSdkCredentials>,
    extra: Record<string, unknown> = {},
  ): Promise<AlibabaSdkResult<AlibabaOrderDetailPayload>> {
    const api = 'com.alibaba.trade/alibaba.trade.get.buyerView';
    const params: Record<string, unknown> = { webSite: '1688', orderId };
    for (const [k, v] of Object.entries(extra)) params[k] = v;

    // 旧 msg 拼接取的是**最后一次响应**的 message/errorMessage；链耗尽时保留该口径
    let lastResp: Record<string, unknown> | null = null;

    for (let i = 0; i < credentialsChain.length; i += 1) {
      const credentials = credentialsChain[i]!;
      const first = await this.execute(api, params, credentials);
      lastResp = first.resp;

      const isPermissionError =
        lastResp !== null &&
        typeof lastResp === 'object' &&
        (lastResp['errorCode'] ?? '') === 'PEMISSION_ERROR';

      let finalResp = lastResp;
      if (isPermissionError && i + 1 < credentialsChain.length) {
        // 旧换 token 重试一次（凭证不可变 ⇒ 链位 +1 同义）
        finalResp = (await this.execute(api, params, credentialsChain[i + 1]!)).resp;
        lastResp = finalResp;
      }

      const result = extractOrderResult(finalResp);
      if (result !== null) return { code: 200, data: result };
      break; // 非权限错直落信封；权限错也只跳一次（旧 else 语义），链上多凭证≠多轮重试
    }

    return this.failEnvelopeOfOrder(lastResp);
  }

  // -----------------------------------------------------------------------
  // 子账号 token 三件套（旧 getOauthAccount / addSubAccount / getOauthTokenByAccount 1:1）
  // -----------------------------------------------------------------------

  /** 旧 `getOauthAccount` 1:1：`system.oauth2/subaccount.auth.list` → `returnValue` */
  async getOauthAccount(
    accounts: string | string[],
    extra: Record<string, unknown> = {},
    credentials?: AlibabaSdkCredentials,
  ): Promise<AlibabaSdkResult<SubAccountAuthItem[]>> {
    return this.subAccountAuthCall(
      'system.oauth2/subaccount.auth.list',
      accounts,
      extra,
      credentials,
    );
  }

  /** 旧 `addSubAccount` 1:1：`system.oauth2/subaccount.auth.add`（R1 内部兜底用） */
  async addSubAccount(
    accounts: string | string[],
    extra: Record<string, unknown> = {},
    credentials?: AlibabaSdkCredentials,
  ): Promise<AlibabaSdkResult<SubAccountAuthItem[]>> {
    return this.subAccountAuthCall(
      'system.oauth2/subaccount.auth.add',
      accounts,
      extra,
      credentials,
    );
  }

  /**
   * 旧 `getOauthTokenByAccount($account)` 1:1。
   *
   * @param cachedToken 本地缓存命中值（`v2_platform_sub_account.token` JSON accessToken；
   *   旧外层 Cache::remember 30 分钟——R1 直查表不复现缓存层，语义等价）
   * @param saveToken 拿到接口 token 后的回表动作（旧 updateOrCreate）
   * @returns 200 = `{ token, from }`（from 0 = 本地缓存 / 1 = 接口 list / 2 = add 兜底）；
   *          40000 = 旧失败信封（本地与接口都 miss，或 credentials 缺失）
   */
  async getOauthTokenByAccount(
    account: string,
    io: {
      cachedToken: string | null;
      saveToken: (accessToken: string) => Promise<void>;
    },
    credentials: AlibabaSdkCredentials,
  ): Promise<AlibabaSdkResult<{ token: string; from: 0 | 1 | 2 }>> {
    if (io.cachedToken !== null && io.cachedToken !== '') {
      return { code: 200, data: { token: io.cachedToken, from: 0 } };
    }

    // 先查接口，失败了再调用添加接口（旧注释原话）
    const listed = await this.subAccountAuthCall(
      'system.oauth2/subaccount.auth.list',
      account,
      {},
      credentials,
    );
    if (listed.code === 200) {
      const item = firstAccessToken(listed.data);
      if (item !== null) {
        await io.saveToken(item); // 旧 updateOrCreate
        return { code: 200, data: { token: item, from: 1 } };
      }
    }

    const added = await this.subAccountAuthCall(
      'system.oauth2/subaccount.auth.add',
      account,
      {},
      credentials,
    );
    if (added.code === 200) {
      const item = firstAccessToken(added.data);
      if (item !== null) {
        await io.saveToken(item);
        return { code: 200, data: { token: item, from: 2 } };
      }
    }

    // 旧：两个都失败直接把最后一个 40000 信封往上抛
    return added.code === 200
      ? { code: 40000, msg: '获取子账号授权失败' }
      : { code: 40000, msg: added.msg ?? '获取子账号授权失败', resp: added.resp };
  }

  // -----------------------------------------------------------------------
  // 内部工具
  // -----------------------------------------------------------------------

  private async subAccountAuthCall(
    api: string,
    accounts: string | string[],
    extra: Record<string, unknown>,
    credentials: AlibabaSdkCredentials | undefined,
  ): Promise<AlibabaSdkResult<SubAccountAuthItem[]>> {
    if (!credentials) return { code: 40000, msg: 'alibaba sdk 凭证尚未配置' };
    const list = Array.isArray(accounts) ? accounts : [accounts]; // 旧 is_string 包数组
    const params: Record<string, unknown> = { subUserIdentityList: list };
    for (const [k, v] of Object.entries(extra)) params[k] = v;

    const first = await this.execute(api, params, credentials);
    const items = extractReturnValue(first.resp);
    if (items !== null) return { code: 200, data: items };
    return { code: 40000, msg: errorMessageOf(first.resp), resp: first.resp ?? undefined };
  }

  /** 旧 getOrderDetail 失败信封：msg 取最后一次网关响应的 message/errorMessage 链 */
  private failEnvelopeOfOrder(resp: Record<string, unknown> | null): {
    code: 40000;
    msg: string;
    resp?: Record<string, unknown>;
    data: { error_code: number };
  } {
    return {
      code: 40000,
      msg: `获取订单信息失败，错误原因：${errorMessageOf(resp)}`,
      resp: resp ?? undefined,
      data: { error_code: 40002 },
    };
  }
}

// -------------------------------------------------------------------------
// 提取工具（模块级纯函数，旧 Arr::get 链的收敛点）
// -------------------------------------------------------------------------

/** 取 `resp.result`：PHP `!empty($item)` 同义（`[]`/`null`/`0`/`''` 都算空） */
function extractOrderResult(
  resp: Record<string, unknown> | null,
): AlibabaOrderDetailPayload | null {
  if (resp === null || typeof resp !== 'object') return null;
  const result = resp['result'];
  if (result === null || result === undefined) return null;
  if (Array.isArray(result) && result.length === 0) return null;
  if (typeof result === 'string' && result === '') return null;
  if (typeof result === 'number' && result === 0) return null;
  if (typeof result !== 'object') return null;
  if (Object.keys(result as object).length === 0) return null;
  return result as AlibabaOrderDetailPayload;
}

/** 取 `resp.returnValue`（旧 getOauthAccount/addSubAccount 共用；!empty 判定） */
function extractReturnValue(resp: Record<string, unknown> | null): SubAccountAuthItem[] | null {
  if (resp === null || typeof resp !== 'object') return null;
  const item = resp['returnValue'];
  if (!Array.isArray(item) || item.length === 0) return null;
  return item as SubAccountAuthItem[];
}

/** 旧 `Arr::get($data,'message',Arr::get($data,'errorMsg'))` */
function errorMessageOf(resp: Record<string, unknown> | null): string {
  const v =
    resp !== null && typeof resp === 'object' ? (resp['message'] ?? resp['errorMsg'] ?? '') : '';
  return typeof v === 'string' ? v : '';
}

/** 旧 `Arr::first($result['data'])['accessToken']` / `$result['data'][0]['accessToken']` */
function firstAccessToken(items: SubAccountAuthItem[]): string | null {
  for (const item of items) {
    const token = item['accessToken'];
    if (typeof token === 'string' && token !== '') return token;
  }
  return null;
}
