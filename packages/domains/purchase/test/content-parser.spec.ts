import { describe, expect, it } from 'vitest';
import {
  AlibabaParser,
  BaseParser,
  ContentParserFacade,
  PARSER_TYPE_GOODS,
  PARSER_TYPE_LINK,
  PARSER_TYPE_UNKNOWN,
  TaobaoParser,
  type HttpGetPort,
  type ParsedItem,
} from '../src/content-parser';

/**
 * 商品内容解析器用例（旧 ContentParsers 三件套 + ContentParser 门面的 1:1）：
 *   ① 淘宝链接七形态（item/mi_id/uland-edetail/i{d}.htm/直播间/淘特/秒杀）
 *   ② 1688 链接两形态（offer/{id}.htm / offerId=）
 *   ③ 短链（e.tb.cn / qr.1688.com，fake HttpGetPort；含【】标题补全）
 *   ④ link 兜底 / 空内容 / 多结果排序（typeSortWeight 降序、稳定）
 *   ⑤ twiceParse 跨平台（淘宝短链解出 1688 长链）
 *   ⑥ HTTP 失败上抛（旧无 catch <=> 上抛）
 */

/** 桌面 UA + 不跟随重定向的调用记录（验证旧 Guzzle 选项 1:1） */
function fakeHttp(responder: (url: string) => string): {
  port: HttpGetPort;
  calls: Array<{ url: string; options?: { allowRedirects?: boolean } }>;
} {
  const calls: Array<{ url: string; options?: { allowRedirects?: boolean } }> = [];
  return {
    port: {
      async get(url, options) {
        calls.push({ url, options });
        return responder(url);
      },
    },
    calls,
  };
}

function parse(content: string, http?: HttpGetPort): Promise<ParsedItem[]> {
  return ContentParserFacade.parse(content, '', {}, http);
}

describe('淘宝 goodsLinkParser（旧 Taobao::getGoodsInfoFromGoodsUlr 七形态）', () => {
  const cases: Array<{ name: string; url: string; id: string; miId?: string }> = [
    {
      name: 'item.htm?id=&mi_id=（旧注释原例）',
      url: 'https://item.taobao.com/item.htm?id=1027871163299&mi_id=0000tN6dj-jr-HtdssXGuOpuaSsr6lKt33QoGZ1ZFPHrwvo',
      id: '1027871163299',
      miId: '0000tN6dj-jr-HtdssXGuOpuaSsr6lKt33QoGZ1ZFPHrwvo',
    },
    {
      name: 'item.htm?id= 无 mi_id',
      url: 'https://item.taobao.com/item.htm?id=1027871163299',
      id: '1027871163299',
      miId: '',
    },
    {
      name: 'chaoshi.detail.tmall.com/item.htm',
      url: 'https://chaoshi.detail.tmall.com/item.htm?id=640595163008',
      id: '640595163008',
      miId: '',
    },
    {
      name: 'item_o.htm',
      url: 'https://detail.tmall.com/item_o.htm?id=683250465332',
      id: '683250465332',
      miId: '',
    },
    {
      name: 'tmall.hk goods-detail/goods.html',
      url: 'https://tmall.tmall.hk/goods-detail/goods.html?id=667427893540&sourceType=item&price=42',
      id: '667427893540',
      miId: '',
    },
    {
      name: '兼容错误网址：老链接 + 新版字母数字 id',
      url: 'https://chaoshi.detail.tmall.com/item.htm?id=X4g0DS2OK34iwyyI06AQQCg-XQWo4eH00jgRjx3iB',
      id: 'X4g0DS2OK34iwyyI06AQQCg-XQWo4eH00jgRjx3iB',
      miId: '',
    },
    {
      name: 'uland item/edetail（新版字母 id）',
      url: 'https://uland.taobao.com/item/edetail?id=X4g0DS2OK34iwyyI06AQQCg-XQWo4eH00jgRjx3iB0',
      id: 'X4g0DS2OK34iwyyI06AQQCg-XQWo4eH00jgRjx3iB0',
      miId: '',
    },
    {
      name: 'a.m.tmall.com i{d}.htm',
      url: 'https://a.m.tmall.com/i637438372689.htm?ut_sk=1.VUGnPw6EC2QDACpudkNanbOq_12615387_1645429129733.Copy.tm_detail',
      id: '637438372689',
      miId: '',
    },
    {
      name: '直播间 itemId=',
      url: 'https://diantao.cn/share-landing-page/home.html?ut_sk=1.YUyHTI5FFUADAIsSGdtT91yS_25332598_1646482019506.Copy.tblive-gooddetail-direct-share&itemId=593031858906',
      id: '593031858906',
      miId: '',
    },
    {
      name: '淘特 detail?id=（纯数字形）',
      url: 'https://market.m.taobao.com/app/nozomi/app-h5-detail/main/index.html?id=642577509611&link_launch_performance=Y',
      id: '642577509611',
      miId: '',
    },
    {
      name: '秒杀 itemIds=',
      url: 'https://pages-fast.m.taobao.com/wow/z/app/ltao-fe/xsms-ssr-yyds/external?itemIds=857852381704',
      id: '857852381704',
      miId: '',
    },
    {
      name: '秒杀 item_id=（同族）',
      url: 'https://pages-fast.m.taobao.com/wow/z/app/ltao-fe/xsms-ssr-yyds/external?dddd=222d&item_id=857852381704',
      id: '857852381704',
      miId: '',
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const result = await parse(c.url);
      expect(result).toHaveLength(1);
      expect(result[0]!.type).toBe(PARSER_TYPE_GOODS);
      expect(result[0]!.platform).toBe('taobao');
      expect(result[0]!.detail!.itemId).toBe(c.id);
      expect(result[0]!.detail!.miId).toBe(c.miId);
      expect(result[0]!.keyContent).toBe(c.url);
    });
  }

  it('uland 券链接（quan/detail）→ 跳过，非商品', async () => {
    const result = await parse(
      'https://uland.taobao.com/quan/detail?sellerId=2212235948708&activityId=9799bc00c968498590ef0a78930a6e84',
    );
    expect(result.some((r) => r.type === PARSER_TYPE_GOODS)).toBe(false);
  });

  it('uland 券商品二合一（coupon/edetail 非 item/edetail）→ 跳过', async () => {
    const result = await parse(
      'https://uland.taobao.com/coupon/edetail?traceId=210761&itemId=550189462849&activityId=8664ad',
    );
    expect(result.some((r) => r.type === PARSER_TYPE_GOODS)).toBe(false);
  });

  it('uland item/edetail 不被券跳过规则误杀', async () => {
    const result = await parse('https://uland.taobao.com/item/edetail?id=550189462849');
    expect(result[0]!.detail!.itemId).toBe('550189462849');
  });
});

describe('1688 goodsLinkParser（旧 Alibaba::goodsLinkParser 两形态）', () => {
  it('detail.1688.com/offer/{id}.html（旧注释原例）', async () => {
    const url =
      'https://detail.1688.com/offer/667028716474.html?spm=a313p.92.1hzkwu.1368972594747&short_name=G1.0bRXUE&app=chrome&tracelog=cps';
    const result = await parse(url);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe(PARSER_TYPE_GOODS);
    expect(result[0]!.platform).toBe('1688');
    expect(result[0]!.detail!.itemId).toBe('667028716474');
    expect(result[0]!.detail!.itemUrl).toBe('https://detail.1688.com/offer/667028716474.html');
  });

  it('m.1688.com/offer/{id}.html（share_token 含 +/== 的 uri）', async () => {
    const url =
      'https://m.1688.com/offer/641051079459.html?share_token=BfuQCzCg4d3jEfcD09ZUIQgvqAzp4k/FIneEUhp0X0SfgupwxVFqWQ==&offerId=641051079459&spm=a262eq.8992535/20220307.5103953.0';
    const result = await parse(url);
    expect(result).toHaveLength(1);
    expect(result[0]!.detail!.itemId).toBe('641051079459');
  });

  it('detail.m.1688.com/page/index.htm?offerId=（第二形态）', async () => {
    const result = await parse('http://detail.m.1688.com/page/index.htm?offerId=658711457088');
    expect(result).toHaveLength(1);
    expect(result[0]!.platform).toBe('1688');
    expect(result[0]!.detail!.itemId).toBe('658711457088');
  });

  it('同一文本多个 1688 offer → 多条（旧 preg_match_all）', async () => {
    const result = await parse(
      'https://detail.1688.com/offer/111.html 和 https://detail.1688.com/offer/222.html',
    );
    const ids = result.filter((r) => r.platform === '1688').map((r) => r.detail!.itemId);
    expect(ids).toEqual(['111', '222']);
  });
});

describe('e.tb.cn 短链（旧 Taobao::goodsCommandParser）', () => {
  it('页面含 var url → 二次解析出商品', async () => {
    const http = fakeHttp(
      () => "<script>var url = 'https://item.taobao.com/item.htm?id=7788991122'</script>",
    );
    const result = await parse(
      '大促价保 https://e.tb.cn/h.6AqckuP9kKtQa4b?tk=rg4AVKFWSWO MF168 裙子',
      http.port,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe(PARSER_TYPE_GOODS);
    expect(result[0]!.detail!.itemId).toBe('7788991122');
    // keyContent 被 previous（原短链）覆盖（旧 executeParseMethod 语义）
    expect(result[0]!.keyContent).toBe('https://e.tb.cn/h.6AqckuP9kKtQa4b?tk=rg4AVKFWSWO');
  });

  it('页面无 var url → 无商品，taobao 域名走 link 兜底（旧 parseLinkContent 语义）', async () => {
    const http = fakeHttp(() => '<html>no match</html>');
    const result = await parse('https://e.tb.cn/h.XXXX', http.port);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe(PARSER_TYPE_LINK);
    expect(result[0]!.platform).toBe('taobao');
  });

  it('商品标题为空 →【】补全实际是死代码路径（旧传单条链接非全文，1:1 保留）', async () => {
    const http = fakeHttp(() => "var url = 'https://item.taobao.com/item.htm?id=5556667777'");
    const result = await parse(
      '【户外折叠桌便携露营桌轻便铝合金战术桌】复制￥VeYbQky30geax￥，打开【手机阿里】查看：https://e.tb.cn/h.abc123',
      http.port,
    );
    // 解析器收到的是单条链接（无【】）⇒ itemTitle 保持 undefined；消费端不得依赖它
    expect(result[0]!.detail!.itemTitle).toBeUndefined();
    expect(result[0]!.detail!.itemId).toBe('5556667777');
  });

  it('HTTP 请求带 allow_redirects=false + 桌面 UA（旧 Guzzle 选项）', async () => {
    const http = fakeHttp(() => "var url = 'https://item.taobao.com/item.htm?id=1'");
    await parse('https://e.tb.cn/h.zzz', http.port);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe('https://e.tb.cn/h.zzz');
    expect(http.calls[0]!.options?.allowRedirects).toBe(false);
    expect(http.calls[0]!.options?.userAgent).toContain('Chrome/83.0.4103.116');
  });
});

describe('qr.1688.com 短链（旧 Alibaba::shortLinkParser）', () => {
  it('页面含 1688.com/offer?id={id}.html → 1688 商品', async () => {
    const http = fakeHttp(() => 'window.location="1688.com/offer?id=123456789.html"');
    const result = await parse('https://qr.1688.com/s/whkdI9MZ', http.port);
    expect(result).toHaveLength(1);
    expect(result[0]!.platform).toBe('1688');
    expect(result[0]!.detail!.itemId).toBe('123456789');
  });

  it('页面含 var wirelessUrl → url 参数二次解析', async () => {
    // 旧真实形态：wirelessUrl 的 query 里带 urlencoded 的目标长链
    const http = fakeHttp(
      () =>
        'var wirelessUrl="https://h5.m.1688.com/xxx/index.htm?url=https%3A%2F%2Fm.1688.com%2Foffer%2F667028716474.html%3Fx%3D1"',
    );
    const result = await parse('https://qr.1688.com/s/whkdI9MZ', http.port);
    expect(result).toHaveLength(1);
    expect(result[0]!.platform).toBe('1688');
    expect(result[0]!.detail!.itemId).toBe('667028716474');
  });

  it('页面两形态都无 → 1688 域名走 link 兜底', async () => {
    const http = fakeHttp(() => '<html>captcha</html>');
    const result = await parse('https://qr.1688.com/s/whkdI9MZ', http.port);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe(PARSER_TYPE_LINK);
    expect(result[0]!.platform).toBe('1688');
  });
});

describe('twiceParse 跨平台（旧 Parser::twiceParse 注释：淘宝短链解出 1688 明文长链）', () => {
  it('e.tb.cn 页面 url 指向 1688 → 走注册表全量解析', async () => {
    const http = fakeHttp(() => "var url = 'https://detail.1688.com/offer/9988776655.html'");
    const result = await parse('https://e.tb.cn/h.crossPlatform', http.port);
    expect(result).toHaveLength(1);
    expect(result[0]!.platform).toBe('1688');
    expect(result[0]!.detail!.itemId).toBe('9988776655');
  });
});

describe('门面与兜底（旧 ContentParser.php）', () => {
  it("空内容直接返回空（旧 null/'' 两判）", async () => {
    expect(await parse('')).toEqual([]);
  });

  it('taobao 域名下非商品链接 → link 类型兜底', async () => {
    const result = await parse('https://www.taobao.com/');
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe(PARSER_TYPE_LINK);
    expect(result[0]!.platform).toBe('taobao');
  });

  it('多结果按 typeSortWeight 降序、稳定（PHP sortByDesc 稳定 <=> JS sort 稳定）', async () => {
    // 同一文本：淘宝商品（goods,100）+ taobao 非商品链接（link,50，另一条链接）
    const result = await parse(
      'https://item.taobao.com/item.htm?id=111 然后看 https://www.taobao.com/help',
    );
    const goodsIdx = result.findIndex((r) => r.type === PARSER_TYPE_GOODS);
    const linkIdx = result.findIndex((r) => r.type === PARSER_TYPE_LINK);
    expect(goodsIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeGreaterThan(goodsIdx);
  });

  it('typeSortWeight 数值表（旧权重 1:1）', () => {
    expect(BaseParser.typeSortWeight(PARSER_TYPE_GOODS)).toBe(100);
    expect(BaseParser.typeSortWeight(PARSER_TYPE_LINK)).toBe(50);
    expect(BaseParser.typeSortWeight(PARSER_TYPE_UNKNOWN)).toBe(20);
    expect(BaseParser.typeSortWeight('不存在的类型')).toBe(0);
    expect(BaseParser.typeSortWeight(null)).toBe(0);
  });

  it('HTTP 失败上抛（旧无 catch <=> 冒泡到调用方）', async () => {
    const port: HttpGetPort = {
      get: async () => {
        throw new Error('ECONNRESET');
      },
    };
    await expect(parse('https://e.tb.cn/h.boom', port)).rejects.toThrow('ECONNRESET');
  });
});

describe('getUrlQueryParams / uriRegExp（旧 Parser 静态工具）', () => {
  it('getUrlQueryParams：带 key / 不带 key / 默认值', () => {
    expect(BaseParser.getUrlQueryParams('https://x.com/a?url=https%3A%2F%2Fy.com%2Fz', 'url')).toBe(
      'https://y.com/z',
    );
    expect(BaseParser.getUrlQueryParams('https://x.com/a?url=1', 'missing', 'dft')).toBe('dft');
    expect(BaseParser.getUrlQueryParams('https://x.com/a?url=1')).toEqual({ url: '1' });
    expect(BaseParser.getUrlQueryParams('https://x.com/a')).toEqual({});
  });

  it('AlibabaParser/TaobaoParser 域名与平台标识（旧静态属性）', () => {
    expect(AlibabaParser.domains).toBe('(?:1688)\\.(?:com)');
    expect(AlibabaParser.platform).toBe('1688');
    expect(TaobaoParser.platform).toBe('taobao');
  });
});
