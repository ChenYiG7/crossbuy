import { createHash, createHmac } from 'node:crypto';
import type { TtlCache } from '@crossbuy/cache';

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
 * - `getItemDetailFromFenxiaoApi`（Alibaba.php:316-376）：分销商品详情，入参
 *   `offerDetailParam: {offerId:(int)$itemId, country:'ja'}`；**无 PEMISSION_ERROR 轮换**
 *   （旧该方法内不换 token）；缓存 = Laravel Cache 1h（key 含 sdkInitParam 的 md5，
 *   值 = 原始响应体串，仅成功响应落缓存）；SKU 兜底 =
 *   `EnsureAlibabaProductSkuInfosService::fillIfMissing`（一个品无 productSkuInfos 时
 *   按商品级数据补默认 SKU，1:1 移植在本文件模块级）。
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

/**
 * 分销商品详情 payload（旧 `$data['result']` 形态：`{result: {...商品字段...}, ...}`；
 * 键随平台返回漂移，取宽形态——消费方只认 `result.productSkuInfos` 等固定路径）。
 */
export interface FenxiaoProductDetail {
  result?: Record<string, unknown>;
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
  // getItemDetailFromFenxiaoApi（旧 Alibaba.php:316-376 1:1）
  // -----------------------------------------------------------------------

  /**
   * 旧 `Alibaba::getItemDetailFromFenxiaoApi($itemId, $extra, $useCache)`。
   *
   * API = `com.alibaba.fenxiao.crossborder/product.search.queryProductDetail`，
   * 入参 `offerDetailParam: {offerId: (int)$itemId, country: 'ja'}`。
   *
   * 缓存（旧 Laravel Cache，1:1）：key = `1688-kj-detial-use-fenxiao-api` +
   * md5(json_encode(sdkInitParam)) + itemId；TTL 1h；**值 = 原始响应体字符串**
   * （命中后解码走与实时路径完全相同的 decode）。`useCache=false` ⇒ 先 forget 再查
   * （旧 `Cache::forget` 语义）。仅当**实时**响应解析出非空 `result.result` 时才 put
   * （旧 `!empty($item)` 条件）——失败响应不落缓存。
   * ⚠ md5 输入按 PHP json_encode 键序 appid→appkey→token 构造；PHP 默认把 `/` 转义成
   *   `\/` 而 JS 不转——token 含 `/` 时与旧 key 不一致（后果仅缓存 miss，不影响正确性）。
   *
   * SKU 兜底：平台对「一个品」可能不返回 productSkuInfos ⇒ `fillMissingSkuInfos`
   * （旧 EnsureAlibabaProductSkuInfosService::fillIfMissing）按商品级数据补默认 SKU。
   *
   * @param credentials 旧 `new Alibaba()` 默认构造 = 主组 env 三件套；**fenxiao 路径无
   *   PEMISSION_ERROR 轮换**（旧该方法内不换 token，1:1——与 getOrderDetail 不同）。
   * @returns 200 = `{result}`（旧 `$data['result']` 整层）；40000 = 旧信封
   *   （msg = `result.message` ?? '商品可能不存在。'；resp = 解码后的整个响应）。
   */
  async getItemDetailFromFenxiaoApi(
    itemId: string,
    credentials: AlibabaSdkCredentials,
    cache?: TtlCache,
    useCache = true,
  ): Promise<AlibabaSdkResult<FenxiaoProductDetail>> {
    if (itemId === '') {
      return { code: 40000, msg: '商品 id 有误。' };
    }

    // 旧 (int)$itemId 强转：'123abc' → 123、非数值串 → 0
    const offerId = Number.parseInt(itemId, 10);
    const params: Record<string, unknown> = {
      offerDetailParam: { offerId: Number.isNaN(offerId) ? 0 : offerId, country: 'ja' },
    };

    const cacheKey = `1688-kj-detial-use-fenxiao-api${fenxiaoCacheKeySalt(credentials)}${itemId}`;

    let respStr: string | null = null;
    if (cache) {
      if (!useCache) {
        await cache.forget(cacheKey); // 旧 Cache::forget
      } else {
        respStr = await cache.get(cacheKey);
      }
    }

    if (respStr === null || respStr === '') {
      const raw = await this.execute(
        'com.alibaba.fenxiao.crossborder/product.search.queryProductDetail',
        params,
        credentials,
      );
      respStr = raw.original ?? '';
      // 旧 put 条件：实时响应（execute 信封里的 resp）解析出非空 result.result 且 original 非空
      if (respStr !== '' && cache && extractFenxiaoItem(raw.resp) !== null) {
        await cache.put(cacheKey, respStr, FENXIAO_CACHE_TTL_MS);
      }
    }

    return decodeFenxiaoDetail(respStr);
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

// -------------------------------------------------------------------------
// 分销详情解码 + SKU 兜底（旧 getItemDetailFromFenxiaoApi 尾段 +
// EnsureAlibabaProductSkuInfosService 的 1:1 移植）
// -------------------------------------------------------------------------

/** 旧 `Cache::put($cacheKey, $value, 60 * 60)` */
const FENXIAO_CACHE_TTL_MS = 60 * 60 * 1000;

/** 旧 `md5(json_encode($this->sdkInitParam))`（键序 appid→appkey→token，1:1） */
function fenxiaoCacheKeySalt(credentials: AlibabaSdkCredentials): string {
  const json = JSON.stringify({
    appid: credentials.appid,
    appkey: credentials.appkey,
    token: credentials.token,
  });
  return createHash('md5').update(json).digest('hex');
}

/** 旧 `Arr::get($data, 'result.result')`（!empty 判定；实时 put 缓存的条件） */
function extractFenxiaoItem(resp: Record<string, unknown> | null): Record<string, unknown> | null {
  if (resp === null || typeof resp !== 'object') return null;
  const result = resp['result'];
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const item = (result as Record<string, unknown>)['result'];
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  if (Object.keys(item as object).length === 0) return null; // PHP !empty({}) = false
  return item as Record<string, unknown>;
}

/**
 * 旧尾段：json_decode 原始响应 → `result.result` → fillIfMissing → 信封。
 * 缓存命中与实时响应**共用**本解码（旧代码两条路径汇合到同一段，1:1）。
 */
function decodeFenxiaoDetail(respStr: string): AlibabaSdkResult<FenxiaoProductDetail> {
  let data: Record<string, unknown> | null = null;
  if (respStr !== '') {
    try {
      const parsed: unknown = JSON.parse(respStr);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = null; // 旧 json_decode 失败 → null 同义
    }
  }

  const result = data !== null ? data['result'] : null;
  const resultObj =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const item = resultObj !== null ? resultObj['result'] : null;

  // 旧 `!empty($item) && is_array($item)`：空对象不算（PHP !empty({}) = false）
  if (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    Object.keys(item as object).length > 0
  ) {
    const filled = fillMissingSkuInfos(item as Record<string, unknown>);
    // 旧 `$data['result']['result'] = $item; return ['code'=>200,'data'=>$data['result']]`
    // ⇒ result 层其余键（若有）原样带回
    return { code: 200, data: { ...(resultObj ?? {}), result: filled } };
  }

  const message = resultObj !== null ? resultObj['message'] : null;
  return {
    code: 40000,
    msg: message === null || message === undefined ? '商品可能不存在。' : String(message),
    resp: data ?? undefined,
  };
}

const DEFAULT_ATTRIBUTE_ID = 0;
const DEFAULT_ATTRIBUTE_NAME = '规格';
const DEFAULT_ATTRIBUTE_NAME_TRANS = '規格';
const DEFAULT_ATTRIBUTE_VALUE = '默认';
const DEFAULT_ATTRIBUTE_VALUE_TRANS = 'デフォルト';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 旧 `(string)` 强转（null/undefined → ''；不追求 PHP 的 array→'Array' 边角） */
function strOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** 旧 PHP 8 `== 0` 松比较：0 / '0' / '' / null / false / '0.00' 都算零（'abc' 在 PHP 8 不算） */
function isLooseZero(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'boolean') return value === false;
  const n = Number(value);
  return !Number.isNaN(n) && n === 0;
}

/**
 * 旧 `EnsureAlibabaProductSkuInfosService::fillIfMissing`：分销详情对「一个品」可能
 * 不返回 productSkuInfos ⇒ 按商品级数据（saleInfo/fenxiao/image/cargoNumber）补一条
 * 默认 SKU（skuId = offerId，规格 = productAttribute 首项或「規格:デフォルト」）。
 */
export function fillMissingSkuInfos(product: Record<string, unknown>): Record<string, unknown> {
  const skuInfos = product['productSkuInfos'];
  if (Array.isArray(skuInfos) && skuInfos.length > 0) return product;
  return { ...product, productSkuInfos: [buildDefaultSku(product)] };
}

function buildDefaultSku(product: Record<string, unknown>): Record<string, unknown> {
  const saleInfo = asRecord(product['productSaleInfo']);
  const fenxiao = asRecord(saleInfo['fenxiaoSaleInfo']);
  const images = asArray(asRecord(product['productImage'])['images']);
  const imageUrl = strOf(images[0]);
  const price = resolveWholesalePrice(saleInfo, fenxiao);
  const cargoNumber = strOf(product['productCargoNumber']);

  const sku: Record<string, unknown> = {
    skuId: product['offerId'] ?? '',
    amountOnSale: saleInfo['amountOnSale'] ?? 0,
    price,
    consignPrice: saleInfo['consignPrice'] ?? price,
    cargoNumber,
    skuAttributes: resolveSkuAttributes(product, imageUrl),
  };

  const retailPrice = saleInfo['retailPrice'];
  if (retailPrice !== null && retailPrice !== undefined && retailPrice !== '') {
    sku['retailPrice'] = retailPrice;
  }
  const promotionPrice = saleInfo['promotionPrice'];
  if (promotionPrice !== null && promotionPrice !== undefined && promotionPrice !== '') {
    sku['promotionPrice'] = promotionPrice;
  }

  const fenxiaoPriceInfo: Record<string, unknown> = { offerPrice: fenxiao['offerPrice'] ?? price };
  const onePiecePrice = fenxiao['onePiecePrice'];
  if (onePiecePrice !== null && onePiecePrice !== undefined && onePiecePrice !== '') {
    fenxiaoPriceInfo['onePiecePrice'] = onePiecePrice;
  }
  sku['fenxiaoPriceInfo'] = fenxiaoPriceInfo;
  if (Object.keys(fenxiao).length > 0) {
    sku['fenxiaoSaleInfo'] = fenxiao;
  }

  return sku;
}

/** 旧 resolveWholesalePrice：price → consignPrice → fenxiao.offerPrice → priceRangeList[0].price */
function resolveWholesalePrice(
  saleInfo: Record<string, unknown>,
  fenxiao: Record<string, unknown>,
): unknown {
  let price: unknown = saleInfo['price'] ?? 0;
  if (isLooseZero(price)) price = saleInfo['consignPrice'] ?? 0;
  if (isLooseZero(price)) price = fenxiao['offerPrice'] ?? 0;
  if (isLooseZero(price)) {
    const ranges = asArray(saleInfo['priceRangeList']);
    price = asRecord(ranges[0])['price'] ?? 0;
  }
  return price;
}

/** 旧 resolveSkuAttributes：productAttribute 首条完整属性 → 单元素数组；否则默认規格 */
function resolveSkuAttributes(
  product: Record<string, unknown>,
  imageUrl: string,
): Array<Record<string, unknown>> {
  const attributes = asArray(product['productAttribute']);
  for (const attr of attributes) {
    const row = asRecord(attr);
    const name = strOf(row['attributeName']).trim();
    const value = strOf(row['value']).trim();
    if (name === '' || value === '') continue;

    const nameTrans = strOf(row['attributeNameTrans']).trim();
    const valueTrans = strOf(row['valueTrans']).trim();
    return [
      {
        attributeId: row['attributeId'] ?? DEFAULT_ATTRIBUTE_ID,
        attributeName: name,
        attributeNameTrans: nameTrans !== '' ? nameTrans : name,
        value,
        valueTrans: valueTrans !== '' ? valueTrans : value,
        skuImageUrl: imageUrl,
      },
    ];
  }

  return [
    {
      attributeId: DEFAULT_ATTRIBUTE_ID,
      attributeName: DEFAULT_ATTRIBUTE_NAME,
      attributeNameTrans: DEFAULT_ATTRIBUTE_NAME_TRANS,
      value: DEFAULT_ATTRIBUTE_VALUE,
      valueTrans: DEFAULT_ATTRIBUTE_VALUE_TRANS,
      skuImageUrl: imageUrl,
    },
  ];
}
