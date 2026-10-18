/**
 * 商品内容解析器（旧 `App\Libraries\ContentParsers\{Parser,Taobao,Alibaba}` +
 * `App\Libraries\ContentParser` 门面的 1:1 迁移）——chrome 插件粘贴文本 / 加购
 * URL → 平台 + goodsId + miId。
 *
 * 1:1 锚点（旧仓，只读参考）：
 * - `ContentParsers/Parser.php`：基类（类型常量 / 疑似链接粗匹配 / 域名过滤 /
 *   注册解析器执行 / TWICE 解析 / 排序权重 / URL 参数解析）
 * - `ContentParsers/Taobao.php`：`goodsCommandParser`（e.tb.cn 短链，需 HTTP）、
 *   `goodsLinkParser` + `getGoodsInfoFromGoodsUlr`（七种链接形态正则）
 * - `ContentParsers/Alibaba.php`：`shortLinkParser`（qr.1688.com 短链，需 HTTP）、
 *   `goodsLinkParser`（offer/{id}.htm 与 offerId=/businessId= 两形态）
 * - `ContentParser.php`：门面（注册表 [Taobao, Alibaba] / executeParse 汇总 /
 *   parse 主程序——缓存由调用方按 `parse_content_v2:{md5}` 1 分钟包，R1 落在
 *   组合根 `createUrlParser`，因为缓存后端（Redis/内存）是部署面关注点）
 *
 * 差异登记（R1）：
 * - HTTP 经 `HttpGetPort` 注入（旧 Guzzle `allow_redirects => false` + 桌面 UA，
 *   同步阻塞 <=> R1 async port）——整条解析链因此是 async（纯正则路径无实际等待）。
 * - HTTP 失败直接上抛（旧无 try/catch，异常冒泡到 mutation 层 <=> 本实现上抛）。
 * - `debug` 分支（`apiResponse` 汇总）保留结构；无调用方传 debug，不单独验证。
 */

// ---------------------------------------------------------------------------
// 类型常量（旧 Parser::TYPE_*）
// ---------------------------------------------------------------------------

export const PARSER_TYPE_COUPON = 'coupon';
export const PARSER_TYPE_GOODS = 'goods';
export const PARSER_TYPE_SHOP = 'shop';
export const PARSER_TYPE_ACTIVITY = 'activity';
export const PARSER_TYPE_LIVE = 'live';
export const PARSER_TYPE_URL = 'url';
export const PARSER_TYPE_LINK = 'link';
export const PARSER_TYPE_KEYWORD = 'searchKeyword';
export const PARSER_TYPE_UNKNOWN = 'unknown';

// ---------------------------------------------------------------------------
// HTTP 端口（旧 `(new Client())->get($url, ['headers' => ..., 'allow_redirects' => false])`）
// ---------------------------------------------------------------------------

export interface HttpGetPort {
  get(url: string, options?: { userAgent?: string; allowRedirects?: boolean }): Promise<string>;
}

/** 旧短链解析共用的桌面 UA */
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.116 Safari/537.36';

// ---------------------------------------------------------------------------
// 解析结果形状（旧 item 数组）
// ---------------------------------------------------------------------------

export interface ParsedDetail {
  itemId?: string;
  miId?: string;
  itemUrl?: string;
  itemTitle?: string;
  [key: string]: unknown;
}

export interface ParsedItem {
  keyContent: string;
  type: string;
  detail: ParsedDetail | null;
  platform?: string;
  [key: string]: unknown;
}

/** 注册的解析器构造签名（旧 `Parser[]`；静态面在实例化后等价） */
export type ParserFactory = new (
  content: string,
  previous?: string,
  extra?: Record<string, unknown>,
  http?: HttpGetPort,
) => BaseParser;

// ---------------------------------------------------------------------------
// 基类（旧 Parser.php）
// ---------------------------------------------------------------------------

export abstract class BaseParser {
  /** 旧 `public static $uriRegExp`（注意末尾 `*`：可空） */
  static uriRegExp = '[\\w\\-./?%&=#$:+~;@,*!]*';

  /** 旧 `public static $domains`（子类覆盖） */
  static domains: string | undefined;

  /** 旧 `public static $platform`（子类覆盖；空 = 泛内容解析器，无 link 兜底） */
  static platform: string | undefined = '';

  /** 旧 `public static $weChatMpNames` */
  static weChatMpNames: string[] = [];

  /** 旧 `registerParser`（子类覆盖；方法名动态派发，见 executeParseMethod） */
  protected registerParser: string[] = [];

  /** 旧 `registerCodeParser`（口令解析器；本迁移无子类使用，保留字段） */
  protected registerCodeParser: string[] = [];

  content: string;
  previous: string;
  result: ParsedItem[] = [];
  extra: Record<string, unknown>;
  debug: boolean;
  apiResponse: Record<string, unknown>[] = [];

  constructor(
    content = '',
    previous = '',
    extra: Record<string, unknown> = {},
    /** 短链解析用 HTTP（旧 Guzzle 在解析器内 new；R1 经端口注入） */
    public http?: HttpGetPort,
  ) {
    this.content = content;
    this.previous = previous;
    this.extra = extra;
    this.debug = !this.phpEmpty(extra['debug']);
  }

  /** 旧 `static::make(...)` */
  static make(this: ParserFactory, ...params: ConstructorParameters<ParserFactory>): BaseParser {
    return new this(...params);
  }

  /** 旧 `static::parse($content, $previous, $extra)` */
  static async parse(
    this: ParserFactory,
    content: string,
    previous = '',
    extra: Record<string, unknown> = {},
  ): Promise<ParsedItem[]> {
    const parser = new this(content, previous, extra);
    await parser.parseContent();
    return parser.getResult();
  }

  /** 旧 `getUriRegExp()` */
  static getUriRegExp(): string {
    return BaseParser.uriRegExp;
  }

  /** 旧 `getDomainRegExp()` */
  getDomainRegExp(): string | undefined {
    return (this.constructor as typeof BaseParser).domains;
  }

  /** 旧 `parseContent()` */
  async parseContent(): Promise<this> {
    await this.parseLinkContent();
    return this;
  }

  /**
   * 旧 `getLinkMatchContent()`——粗匹配疑似链接，再按域名过滤。
   *
   * PHP 细节：`array_unique` 保序去重（首个出现的键）<=> JS Set 保序；
   * `[^%]` 排除域名后紧跟 % 的（避免匹配 urlencode 的内嵌链接）。
   */
  protected getLinkMatchContent(): string[] {
    const domains = this.getDomainRegExp() ?? '';
    const uriRegExp = BaseParser.getUriRegExp();
    const links: string[] = [];
    // 旧 urlRegex（i flag；JS 同语义）
    const urlRegex = `(?:(?:https?:)?//)?(?:[\\w.-]+\\.)?[\\w-]+?\\.[\\w-]+?${uriRegExp}`;
    const coarse = [...this.content.matchAll(new RegExp(urlRegex, 'gi'))].map((m) => m[0]);
    const seen = new Set<string>();
    for (const value of coarse) {
      // array_unique 保序去重
      if (seen.has(value)) continue;
      seen.add(value);
      // 旧域名过滤（同样 i flag）
      const domainFilter = new RegExp(
        `^(?:(?:https?:)?//)?(?:[\\w.-]+\\.)?${domains}[^%]${uriRegExp}`,
        'i',
      );
      if (domainFilter.test(value)) links.push(value);
    }
    return links;
  }

  /** 旧 `parseLinkContent()` */
  protected async parseLinkContent(): Promise<this> {
    const links = this.getLinkMatchContent();
    for (const link of links) {
      let result: ParsedItem[] = [];
      for (const method of this.registerParser) {
        const subRes = await this.executeParseMethod(method, link);
        result.push(...subRes);
      }
      // 未匹配到规则 → link 类型兜底（无平台标识的泛解析器不兜底）
      if (result.length === 0 && (this.constructor as typeof BaseParser).platform) {
        const subRes = await this.executeParseMethod('linkParser', link);
        result.push(...subRes);
      }
      this.result.push(...result);
    }
    return this;
  }

  /**
   * 旧 `executeParseMethod($method, $content)`。
   *
   * 细节：`method_exists` 检查（TS 用 typeof function）；`??=` 仅在 null/undefined
   * 时补平台标识（'0' 保留）；`previous` 非空时覆盖 keyContent；有结果才重置
   * apiResponse（防止请求结果无人认领被污染）。
   */
  protected async executeParseMethod(method: string, content: string): Promise<ParsedItem[]> {
    const fn = (this as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') return [];
    const subRes = await (fn as (c: string) => Promise<ParsedItem[]> | ParsedItem[]).call(
      this,
      content,
    );
    for (const item of subRes) {
      item['platform'] ??= (this.constructor as typeof BaseParser).platform;
      if (this.previous) {
        item['keyContent'] = this.previous;
      }
      if (this.debug) {
        const debugBag = (item['debug'] ?? {}) as Record<string, unknown>;
        debugBag['apiResponse'] = {
          ...this.getApiResponseMerged(),
          ...((debugBag['apiResponse'] as Record<string, unknown>) ?? {}),
        };
        item['debug'] = debugBag;
      }
    }
    if (subRes.length > 0) this.apiResponse = [];
    return subRes;
  }

  /** 旧 `getApiResponse()` 的合并面（debug 用；array_merge(apiResponse, item.debug.apiResponse)） */
  private getApiResponseMerged(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const resp of this.apiResponse) Object.assign(merged, resp);
    return merged;
  }

  /** 旧 `linkParser($content)`（link 类型兜底） */
  linkParser(content: string): ParsedItem[] {
    return [
      {
        keyContent: content,
        type: PARSER_TYPE_LINK,
        detail: { title: '', url: content },
      },
    ];
  }

  /** 旧 `unknownParser($content)` */
  unknownParser(content: string): ParsedItem[] {
    return [
      {
        keyContent: content,
        type: PARSER_TYPE_UNKNOWN,
        detail: null,
      },
    ];
  }

  /**
   * 旧 `twiceParse($content, $previous)`——本平台域名走自身解析，
   * 否则遍历注册表全量解析（如淘宝短链解出 1688 明文长链）。
   *
   * ⚠ 注册表由 `setParserRegistry` 注入（旧 `ContentParser::registerParser()`，
   * 静态绑定 <=> R1 模块级注入，见文件末）。
   */
  protected async twiceParse(content: string, previous = ''): Promise<ParsedItem[]> {
    const result: ParsedItem[] = [];
    const domains = this.getDomainRegExp() ?? '';
    const selfMatch = new RegExp(`(?:(?:https?:)?//)?[\\w.-]*?${domains}`, 'i');
    if (selfMatch.test(content)) {
      // 本平台：用当前实例的静态面再解（previous 传递，extra/http 继承）
      const instance = new (this.constructor as unknown as ParserFactory)(
        content,
        previous,
        this.extra,
        this.http,
      );
      await instance.parseContent();
      result.push(...instance.getResult());
    } else {
      for (const parser of parserRegistry) {
        const instance = new parser(content, previous, this.extra, this.http);
        await instance.parseContent();
        result.push(...instance.getResult());
        if (result.length > 0) break;
      }
    }
    return result;
  }

  /** 旧 `getResult()` */
  getResult(): ParsedItem[] {
    return this.result;
  }

  /** 旧 `resetApiResponse()` */
  resetApiResponse(): this {
    this.apiResponse = [];
    return this;
  }

  /**
   * 旧 `typeSortWeight($type)`（PHP 数组字面量 <=> Record；`?? 0` 同语义）
   */
  static typeSortWeight(type: string | null): number {
    const weight: Record<string, number> = {
      [PARSER_TYPE_GOODS]: 100,
      [PARSER_TYPE_COUPON]: 90,
      [PARSER_TYPE_ACTIVITY]: 80,
      [PARSER_TYPE_SHOP]: 70,
      [PARSER_TYPE_LIVE]: 60,
      [PARSER_TYPE_LINK]: 50,
      [PARSER_TYPE_URL]: 40,
      [PARSER_TYPE_KEYWORD]: 30,
      [PARSER_TYPE_UNKNOWN]: 20,
    };
    return weight[type ?? ''] ?? 0;
  }

  /**
   * 旧 `getUrlQueryParams($url, $key, $default)`——
   * PHP parse_url+parse_str；`isset($key)` 判定（= 传了 key 参数）。
   */
  static getUrlQueryParams(
    url: string,
    key?: string,
    defaultValue: string | null = null,
  ): string | string[] | Record<string, string> | null {
    const queryStart = url.indexOf('?');
    // 旧 parse_str 语义：+ → 空格（URLSearchParams 同）；重复键后者覆盖前者（PHP 后者覆盖同）
    const query = queryStart === -1 ? '' : url.slice(queryStart + 1);
    const params = new URLSearchParams(query);
    if (key !== undefined) {
      return params.has(key) ? (params.get(key) as string) : defaultValue;
    }
    const all: Record<string, string> = {};
    for (const [k, v] of params) all[k] = v;
    return all;
  }

  /** PHP `empty()` 语义（'0'/''/null/undefined/false 均空）——解析器多处以 empty 判真 */
  protected phpEmpty(value: unknown): boolean {
    return (
      value === undefined || value === null || value === '' || value === '0' || value === false
    );
  }
}

// ---------------------------------------------------------------------------
// 注册表注入（旧 ContentParser::registerParser() 的静态绑定 <=> R1 模块级）
// twiceParse 与 executeParse 共用；模块加载尾声 setParserRegistry 调用一次。
// ---------------------------------------------------------------------------

let parserRegistry: ParserFactory[] = [];

export function setParserRegistry(factories: ParserFactory[]): void {
  parserRegistry = factories;
}

// ---------------------------------------------------------------------------
// 淘宝解析器（旧 ContentParsers/Taobao.php）
// ---------------------------------------------------------------------------

/** 旧 `Taobao::$domains` */
const TAOBAO_DOMAINS = '(?:tb|taobao|tmall|diantao|ltao)\\.(?:com|cn|hk)';
/** 旧 `Taobao::$goodsIdRegExp`（纯数字 或 字母+数字-字母+数字 新版） */
const TAOBAO_GOODS_ID = '(?:[A-Za-z0-9]+-[A-Za-z0-9]+|\\d+)';
/** 旧 `Taobao::$miIdRegExp` */
const TAOBAO_MI_ID = '([^&]+)';

export class TaobaoParser extends BaseParser {
  static override domains = TAOBAO_DOMAINS;
  static override platform = 'taobao';

  protected override registerParser = ['goodsCommandParser', 'goodsLinkParser'];

  /**
   * 旧 `goodsCommandParser($content)`——e.tb.cn 短链：GET 页面 → 提取
   * `var url = '...'` → twiceParse 二次解析 → 标题为空时用原文【】补全。
   *
   * ⚠ 1:1 保留旧结构怪点：`if (!$result) continue;` 是**每轮**检查 result
   * （首轮无产出即跳过后续短链），不是循环后判断。
   */
  async goodsCommandParser(content: string): Promise<ParsedItem[]> {
    const matches = [...content.matchAll(/https:\/\/e\.tb\.(?:cn|com)\/[^\s]+/g)];
    const result: ParsedItem[] = [];
    for (const m of matches) {
      const value = m[0] ?? '';
      // 旧 Guzzle：allow_redirects=false + 桌面 UA；失败上抛（旧无 catch）
      const contents = await this.mustHttp().get(value, {
        userAgent: DESKTOP_UA,
        allowRedirects: false,
      });

      let realUrl = '';
      const subMatch = /var url = '(https?:\/\/[^\s']+)'/.exec(contents);
      if (subMatch) realUrl = subMatch[1] ?? '';

      if (realUrl) {
        const twiceResult = await this.twiceParse(realUrl, value);
        const firstItem = twiceResult[0];
        // 商品且标题为空 → 【】补全
        // ⚠ 1:1 保留：旧 parseLinkContent 传给解析器的是**单条链接**（非全文），
        // 【】正则只可能匹配到链接本身 ⇒ 此补全在旧代码里实际是死代码路径。
        // 复刻不改语义（不产生错误结果），仅注释登记；消费端不得依赖 itemTitle。
        if (
          firstItem &&
          firstItem['type'] === PARSER_TYPE_GOODS &&
          this.phpEmpty(firstItem['detail']?.['itemTitle'])
        ) {
          const title = /【([\w\W]+?)】/.exec(content);
          if (title && firstItem['detail']) {
            firstItem['detail']['itemTitle'] = title[1] ?? '';
          }
        }
        result.push(...twiceResult);
      }

      if (result.length === 0) {
        // 旧：链接解析失败（logMessage 已注释）continue
        continue;
      }
    }
    return result;
  }

  /** 旧 `goodsLinkParser($content)` */
  goodsLinkParser(content: string): ParsedItem[] {
    const result: ParsedItem[] = [];
    const urlRes = TaobaoParser.getGoodsInfoFromGoodsUlr(content);
    if (!urlRes) return result;
    result.push(
      this.makeGoodsDetails(urlRes['goodsId'] as string, urlRes['url'] as string, urlRes),
    );
    return result;
  }

  /**
   * 旧 `getGoodsInfoFromGoodsUlr($content)`——七种链接形态依次尝试：
   * ① item/item_o/goods.htm?id=..&mi_id=.. ② 同族无 mi_id ③ uland item/edetail
   * ④ a.m.tmall.com i{d}.htm ⑤ 直播间 itemId= ⑥ 淘特 detail?id=(纯数字)
   * ⑦ 秒杀 itemIds/item_id=；跳过：uland 非 edetail / tmallx
   */
  static getGoodsInfoFromGoodsUlr(content: string): Record<string, string> | null {
    const domains = TAOBAO_DOMAINS;
    const uriRegExp = BaseParser.getUriRegExp();
    const baseUrl = `https?:\\/\\/[\\w.\\-]*?${domains}\\/`;
    const goodsId = TAOBAO_GOODS_ID;
    const miId = TAOBAO_MI_ID;

    const attempts: Array<{ re: RegExp; withMiId: boolean }> = [
      // ① 带 mi_id
      {
        re: new RegExp(
          `${baseUrl}${uriRegExp}?(?:item|item_o|goods).htm(?:${uriRegExp}?)[?&]id=(${goodsId})[?&]mi_id=${miId}${uriRegExp}`,
          'i',
        ),
        withMiId: true,
      },
      // ② 无 mi_id
      {
        re: new RegExp(
          `${baseUrl}${uriRegExp}?(?:item|item_o|goods).htm(?:${uriRegExp}?)[?&]id=(${goodsId})${uriRegExp}`,
          'i',
        ),
        withMiId: false,
      },
      // ③ 新版本 uland item/edetail
      {
        re: new RegExp(`${baseUrl}item\\/edetail${uriRegExp}?[?&]id=(${goodsId})${uriRegExp}`, 'i'),
        withMiId: false,
      },
      // ④ a.m.tmall.com i{d}.htm
      { re: new RegExp(`${baseUrl}i(\\d+).htm${uriRegExp}`, 'i'), withMiId: false },
      // ⑤ 直播间商品 itemId=
      {
        re: new RegExp(`${baseUrl}${uriRegExp}?[?&]itemId=(${goodsId})${uriRegExp}`, 'i'),
        withMiId: false,
      },
      // ⑥ 淘特商品详情页（注意：纯数字形 goodsId，非新版字母形）
      {
        re: new RegExp(`${baseUrl}${uriRegExp}?detail${uriRegExp}?[?&]id=(\\d+)${uriRegExp}`, 'i'),
        withMiId: false,
      },
      // ⑦ 淘宝秒杀
      {
        re: new RegExp(`${baseUrl}${uriRegExp}(?:itemIds|item_id)=(${goodsId})${uriRegExp}`, 'i'),
        withMiId: false,
      },
    ];

    let m: RegExpExecArray | null = null;
    let withMiId = false;
    for (const attempt of attempts) {
      m = attempt.re.exec(content);
      if (m) {
        withMiId = attempt.withMiId;
        break;
      }
    }
    if (!m) return null;

    // 券链接跳过（uland 非 item/edetail）
    if (/https?:\/\/uland\.taobao\.com/i.test(content)) {
      if (!/\/item\/edetail/i.test(content)) return null;
    }
    // 猫享链接跳过
    if (new RegExp(`https?:\\/\\/tmallx\\.${domains}${uriRegExp}`, 'i').test(content)) {
      return null;
    }

    return {
      url: m[0] ?? '',
      goodsId: m[1] ?? '',
      miId: withMiId ? (m[2] ?? '') : '',
    };
  }

  /** 旧 `makeGoodsDetails($goodsId, $keyContent, $extra)` */
  protected makeGoodsDetails(
    goodsId: string,
    keyContent: string,
    extra: Record<string, string> = {},
  ): ParsedItem {
    const miId = extra['miId'] ?? '';
    return {
      keyContent,
      type: PARSER_TYPE_GOODS,
      detail: {
        itemId: goodsId,
        miId,
        itemUrl: 'https://item.taobao.com/item.htm?id=' + goodsId + '&mi_id=' + miId,
      },
    };
  }

  private mustHttp(): HttpGetPort {
    if (!this.http) throw new Error('HttpGetPort 未注入：短链解析需要 HTTP');
    return this.http;
  }
}

// ---------------------------------------------------------------------------
// 1688 解析器（旧 ContentParsers/Alibaba.php）
// ---------------------------------------------------------------------------

/** 旧 `Alibaba::$domains` */
const ALIBABA_DOMAINS = '(?:1688)\\.(?:com)';

export class AlibabaParser extends BaseParser {
  static override domains = ALIBABA_DOMAINS;
  static override platform = '1688';

  protected override registerParser = ['shortLinkParser', 'goodsLinkParser'];

  /**
   * 旧 `shortLinkParser($content)`——qr.1688.com 短链：GET 页面（不跟随重定向）
   * → ① `1688.com/offer?id={id}.html` ② `var wirelessUrl="..."` 的 url 参数
   * → twiceParse 二次解析 → 【】补全标题。
   *
   * ⚠ 1:1 保留旧结构怪点（同 goodsCommandParser）：每轮 `if (!$result) continue;`。
   */
  async shortLinkParser(content: string): Promise<ParsedItem[]> {
    const matches = [...content.matchAll(/https:\/\/qr\.1688\.com\/[\w/]+/g)];
    const result: ParsedItem[] = [];
    for (const m of matches) {
      const value = m[0] ?? '';
      const contents = await this.mustHttp().get(value, {
        userAgent: DESKTOP_UA,
        allowRedirects: false,
      });

      let realJdUrl = '';
      const offerMatch = /1688\.com\/offer\?id=(\d+)\.html/.exec(contents);
      if (offerMatch) {
        realJdUrl = `https://detail.1688.com/offer/${offerMatch[1] ?? ''}.html`;
      }
      if (!realJdUrl) {
        const wirelessMatch = /var\swirelessUrl="([\S]+?)"/.exec(contents);
        if (wirelessMatch) {
          // 旧 parse_str 取 url 参数再 urldecode（PHP 二次解；对齐 phpUrldecode）
          const url = BaseParser.getUrlQueryParams(wirelessMatch[1] ?? '', 'url', '') as string;
          realJdUrl = phpUrldecode(url);
        }
      }

      if (realJdUrl) {
        const twiceResult = await this.twiceParse(realJdUrl, value);
        const firstItem = twiceResult[0];
        // ⚠ 同上：链接级【】补全是旧代码死代码路径，1:1 保留不改语义
        if (
          firstItem &&
          firstItem['type'] === PARSER_TYPE_GOODS &&
          this.phpEmpty(firstItem['detail']?.['itemTitle'])
        ) {
          const title = /【([\w\W]+?)】/.exec(content);
          if (title && firstItem['detail']) {
            firstItem['detail']['itemTitle'] = title[1] ?? '';
          }
        }
        result.push(...twiceResult);
      }

      if (result.length === 0) continue;
    }
    return result;
  }

  /**
   * 旧 `goodsLinkParser($content)`——两形态：
   * ① `{sub}.1688.com/offer/{id}.htm{uri}` ② `.../offerId=|businessId={id}`
   */
  goodsLinkParser(content: string): ParsedItem[] {
    const uriRegExp = BaseParser.getUriRegExp();
    let matches = [
      ...content.matchAll(
        new RegExp(`https?:\\/\\/[\\w.]+\\.1688\\.com\\/offer\\/(\\d+)\\.htm${uriRegExp}`, 'g'),
      ),
    ];
    if (matches.length === 0) {
      // http://detail.m.1688.com/page/index.htm?offerId=658711457088
      matches = [
        ...content.matchAll(
          new RegExp(
            `https?:\\/\\/[\\w.]+\\.1688\\.com\\/${uriRegExp}(?:offerId|businessId)=(\\d+)${uriRegExp}`,
            'g',
          ),
        ),
      ];
    }

    const result: ParsedItem[] = [];
    for (const m of matches) {
      const goodsId = m[1] ?? '';
      result.push({
        keyContent: m[0] ?? '',
        type: PARSER_TYPE_GOODS,
        detail: this.goodsDetailByGoodsId(goodsId),
      });
    }
    return result;
  }

  /** 旧 `goodsDetailByGoodsId($goodsId)` */
  protected goodsDetailByGoodsId(goodsId: string): ParsedDetail {
    return { itemId: goodsId, itemUrl: `https://detail.1688.com/offer/${goodsId}.html` };
  }

  private mustHttp(): HttpGetPort {
    if (!this.http) throw new Error('HttpGetPort 未注入：短链解析需要 HTTP');
    return this.http;
  }
}

/**
 * PHP `urldecode`：把 `+` 也当空格（旧 `urldecode($params['url'])`——
 * parse_str 已解一次，此处二次解；JS decodeURIComponent 不解 +，
 * 手工对齐 PHP 语义）。
 */
function phpUrldecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value; // 旧 PHP urldecode 对非法 % 序列原样返回
  }
}

// ---------------------------------------------------------------------------
// 门面（旧 ContentParser.php）
// ---------------------------------------------------------------------------

export class ContentParserFacade {
  /** 旧 `registerParser()`（顺序即优先级） */
  static registerParsers(): ParserFactory[] {
    return [TaobaoParser as unknown as ParserFactory, AlibabaParser as unknown as ParserFactory];
  }

  /**
   * 旧 `executeParse($content, $previous, $extra)`——遍历注册表汇总；
   * 多结果按 `typeSortWeight` 降序（PHP sortByDesc 稳定 <=> JS sort 稳定）。
   */
  static async executeParse(
    content: string,
    previous = '',
    extra: Record<string, unknown> = {},
    http?: HttpGetPort,
  ): Promise<ParsedItem[]> {
    const result: ParsedItem[] = [];
    for (const parser of ContentParserFacade.registerParsers()) {
      const instance = new parser(content, previous, extra, http);
      result.push(...(await instance.parseContent()).getResult());
    }
    if (result.length > 1) {
      return [...result].sort(
        (a, b) => BaseParser.typeSortWeight(b['type']) - BaseParser.typeSortWeight(a['type']),
      );
    }
    return result;
  }

  /**
   * 旧 `parse($content, ...)`——null/'' 直接返回空（旧显式两判）；
   * 缓存（`parse_content_v2:{md5}` 1 分钟）由调用方包，R1 在组合根 createUrlParser。
   */
  static async parse(
    content: string,
    previous = '',
    extra: Record<string, unknown> = {},
    http?: HttpGetPort,
  ): Promise<ParsedItem[]> {
    if (content === null || content === undefined || content === '') return [];
    return ContentParserFacade.executeParse(content, previous, extra, http);
  }
}

// 注册表注入（twiceParse 用；顺序同门面 registerParser）
setParserRegistry(ContentParserFacade.registerParsers());
