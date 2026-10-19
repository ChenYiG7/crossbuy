import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryTtlCache } from '@crossbuy/cache';
import {
  AlibabaSdkClient,
  fillMissingSkuInfos,
  type AlibabaHttpPort,
  type AlibabaSdkCredentials,
} from '../src/alibaba-sdk';

/**
 * 1688 SDK 纯逻辑用例（不触 DB / 不打真网关）：
 *   ① 签名：ksort 顺序、毫秒时间戳、HMAC-SHA1 大写 hex、签名原文含 fullApi/appid
 *   ② execute：数组 json_encode、null 剔除、网络失败 → 超时信封
 *   ③ getOrderDetail：result 提取（PHP !empty 口径）、PEMISSION_ERROR 单跳轮换、
 *      非权限错不轮换、msg 拼接、空凭证链直落信封
 *   ④ getItemDetailFromFenxiaoApi：请求形态（offerId int 强转）、信封、SKU 兜底
 *      （fillMissingSkuInfos）、1h 缓存（命中/不落失败/useCache=false/凭证分 key）
 */

/** 固定时钟（毫秒恒定，签名可重算比对） */
const FIXED_NOW = () => new Date(1_700_000_000_000);

const CREDENTIALS: AlibabaSdkCredentials = {
  appid: '1000001',
  appkey: 'test-appkey',
  token: 'test-token',
};

describe('makeSign（旧 Alibaba.php:1054 1:1）', () => {
  it('按 ksort 字节序拼接 + HMAC-SHA1 大写 hex + 毫秒时间戳', () => {
    const client = new AlibabaSdkClient({ now: FIXED_NOW });
    const { sign, form } = client.makeSign(
      { orderId: '123', webSite: '1688' },
      'param2/1/com.alibaba.trade/alibaba.trade.get.buyerView',
      CREDENTIALS,
    );

    // 签名原文（旧 signBase）手工重算
    const timestamp = String(1_700_000_000_000);
    const expectedBase =
      'param2/1/com.alibaba.trade/alibaba.trade.get.buyerView/1000001' +
      '_aop_timestamp' +
      timestamp +
      'access_token' +
      CREDENTIALS.token +
      'orderId' +
      '123' +
      'webSite' +
      '1688';
    const expected = createHmac('sha1', CREDENTIALS.appkey)
      .update(expectedBase)
      .digest('hex')
      .toUpperCase();
    expect(sign).toBe(expected);

    // form 已含三件套
    expect(form['_aop_timestamp']).toBe(timestamp);
    expect(form['access_token']).toBe(CREDENTIALS.token);
    expect(form['_aop_signature']).toBe(expected);
  });

  it('签名与参数插入顺序无关（ksort 字节序）', () => {
    const client = new AlibabaSdkClient({ now: FIXED_NOW });
    const api = 'param2/1/x';
    const s1 = client.makeSign({ b: '2', a: '1', A: 'x' }, api, CREDENTIALS).sign;
    const s2 = client.makeSign({ A: 'x', b: '2', a: '1' }, api, CREDENTIALS).sign;
    expect(s1).toBe(s2);

    // 手工按字节序（code unit，整串比较）重拼签名原文独立重算：
    // 'A'(65) < '_aop_timestamp'('_'=95) < 'a'(97) < 'access_token'('a' 同前缀更长更大) < 'b'(98)
    const timestamp = String(1_700_000_000_000);
    const paramStr =
      'A' +
      'x' +
      '_aop_timestamp' +
      timestamp +
      'a' +
      '1' +
      'access_token' +
      CREDENTIALS.token +
      'b' +
      '2';
    const expectedBase = `${api}/${CREDENTIALS.appid}${paramStr}`;
    const expected = createHmac('sha1', CREDENTIALS.appkey)
      .update(expectedBase)
      .digest('hex')
      .toUpperCase();
    expect(s1).toBe(expected);
  });
});

describe('execute（旧 Alibaba.php:1404 1:1）', () => {
  function fakeHttp(
    handler: (url: string, form: Record<string, string>) => Promise<{ ok: boolean; body: string }>,
  ): AlibabaHttpPort {
    return { postForm: (url, form) => handler(url, form) };
  }

  it('数组值 json_encode 成串、null 剔除、标量 String 化', async () => {
    let captured: { url: string; form: Record<string, string> } | null = null;
    const client = new AlibabaSdkClient({
      http: fakeHttp(async (url, form) => {
        captured = { url, form };
        return { ok: true, body: JSON.stringify({ result: { ok: true } }) };
      }),
      now: FIXED_NOW,
    });

    await client.execute(
      'com.alibaba.trade/alibaba.trade.get.buyerView',
      { webSite: '1688', orderId: '9' },
      CREDENTIALS,
    );

    expect(captured).not.toBeNull();
    expect(captured!.form['orderId']).toBe('9');
    expect(captured!.url.startsWith('http://gw.open.1688.com/openapi/param2/1/')).toBe(true); // http 非 https
    expect(captured!.url.endsWith('/1000001?')).toBe(true);

    // 数组/对象序列化
    await client.execute('some/api', { paramArr: [{ x: 1 }], dropMe: null }, CREDENTIALS);
    expect(captured!.form['paramArr']).toBe('[{"x":1}]');
    expect('dropMe' in captured!.form).toBe(false); // null 剔除
  });

  it('网络异常 → resp=接口超时信封（HTTP 失败不抛，旧 catch 块语义）', async () => {
    const client = new AlibabaSdkClient({
      http: {
        postForm: async () => {
          throw new Error('ECONNRESET'); // 网络/超时异常 = throw（与旧 Guzzle 一致）
        },
      },
      now: FIXED_NOW,
    });
    const res = await client.execute('x/y', {}, CREDENTIALS);
    expect(res.resp).toEqual({ message: '接口超时，请稍后重试！' });
    expect(res.original).toBe('');
  });

  it('HTTP 非 2xx 但有响应体（http_errors=false）→ 照常 JSON 解析', async () => {
    const client = new AlibabaSdkClient({
      http: {
        postForm: async () => ({ ok: true, body: JSON.stringify({ errorMsg: 'some http error' }) }),
      },
      now: FIXED_NOW,
    });
    const res = await client.execute('x/y', {}, CREDENTIALS);
    expect(res.resp).toEqual({ errorMsg: 'some http error' });
  });

  it('JSON 解析失败 → resp=null（旧 json_decode 失败同义）', async () => {
    const client = new AlibabaSdkClient({
      http: fakeHttp(async () => ({ ok: true, body: 'not-json' })),
      now: FIXED_NOW,
    });
    const res = await client.execute('x/y', {}, CREDENTIALS);
    expect(res.resp).toBeNull();
  });
});

describe('getOrderDetail（旧 Alibaba.php:1079 1:1）', () => {
  const API = 'com.alibaba.trade/alibaba.trade.get.buyerView';

  function httpWithBodies(bodies: string[]): { port: AlibabaHttpPort; calls: () => number } {
    let i = 0;
    return {
      port: {
        postForm: async () => {
          const body = bodies[Math.min(i, bodies.length - 1)]!;
          i += 1;
          return { ok: true, body };
        },
      },
      calls: () => i,
    };
  }

  it('result 存在 → 200 + data=result', async () => {
    const { port } = httpWithBodies([
      JSON.stringify({ result: { baseInfo: { totalAmount: '12.90' }, productItems: [] } }),
    ]);
    const client = new AlibabaSdkClient({ http: port, now: FIXED_NOW });
    const res = await client.getOrderDetail('T1', [CREDENTIALS]);
    expect(res.code).toBe(200);
    if (res.code === 200) {
      expect((res.data.baseInfo as Record<string, unknown>).totalAmount).toBe('12.90');
    }
  });

  it('空结果按 PHP !empty 口径处理（[]/""/{} 都算失败）', async () => {
    for (const result of [[], '', {}, 0, null]) {
      const { port } = httpWithBodies([JSON.stringify({ result })]);
      const client = new AlibabaSdkClient({ http: port, now: FIXED_NOW });
      const res = await client.getOrderDetail('T1', [CREDENTIALS]);
      expect(res.code).toBe(40000);
      expect(res.msg).toBe('获取订单信息失败，错误原因：');
      expect((res.data as { error_code: number }).error_code).toBe(40002);
    }
  });

  it('PEMISSION_ERROR → 单跳换下一个凭证重试一次；成功即收', async () => {
    const chain: AlibabaSdkCredentials[] = [
      CREDENTIALS,
      { appid: CREDENTIALS.appid, appkey: CREDENTIALS.appkey, token: 'hk-token' },
      { appid: CREDENTIALS.appid, appkey: CREDENTIALS.appkey, token: 'frs-token' },
    ];
    const { port, calls } = httpWithBodies([
      JSON.stringify({ errorCode: 'PEMISSION_ERROR' }),
      JSON.stringify({ result: { baseInfo: {} } }),
    ]);
    const client = new AlibabaSdkClient({ http: port, now: FIXED_NOW });
    const res = await client.getOrderDetail('T1', chain);
    expect(res.code).toBe(200);
    expect(calls()).toBe(2); // 一次失败 + 一次轮换成功，不继续烧链
  });

  it('PEMISSION_ERROR 轮换后仍失败 → 40000（一次即止，不烧第三凭证）', async () => {
    const chain: AlibabaSdkCredentials[] = [
      CREDENTIALS,
      { ...CREDENTIALS, token: 'hk-token' },
      { ...CREDENTIALS, token: 'frs-token' },
    ];
    const { port, calls } = httpWithBodies([
      JSON.stringify({ errorCode: 'PEMISSION_ERROR' }),
      JSON.stringify({ message: 'still denied' }),
    ]);
    const client = new AlibabaSdkClient({ http: port, now: FIXED_NOW });
    const res = await client.getOrderDetail('T1', chain);
    expect(res.code).toBe(40000);
    expect(res.msg).toBe('获取订单信息失败，错误原因：still denied');
    expect(calls()).toBe(2);
  });

  it('非权限错误（普通失败）→ 不轮换直接信封', async () => {
    const chain = [CREDENTIALS, { ...CREDENTIALS, token: 'hk-token' }];
    const { port, calls } = httpWithBodies([JSON.stringify({ message: '订单不存在' })]);
    const client = new AlibabaSdkClient({ http: port, now: FIXED_NOW });
    const res = await client.getOrderDetail('T1', chain);
    expect(res.code).toBe(40000);
    expect(res.msg).toBe('获取订单信息失败，错误原因：订单不存在');
    expect(calls()).toBe(1);
  });

  it('空凭证链 → 40000 信封（不发请求）', async () => {
    const { port, calls } = httpWithBodies(['{}']);
    const client = new AlibabaSdkClient({ http: port, now: FIXED_NOW });
    const res = await client.getOrderDetail('T1', []);
    expect(res.code).toBe(40000);
    expect(calls()).toBe(0);
  });

  it('extra 参数并入（旧 array_merge($paramArr, $extra)）', async () => {
    let captured: Record<string, string> | null = null;
    const client = new AlibabaSdkClient({
      http: {
        postForm: async (_url, form) => {
          captured = form;
          return { ok: true, body: JSON.stringify({ result: {} }) };
        },
      },
      now: FIXED_NOW,
    });
    await client.getOrderDetail('T2', [CREDENTIALS], { extraFlag: '1' });
    expect(API).toBe('com.alibaba.trade/alibaba.trade.get.buyerView'); // API 名锚点
    expect(captured!['extraFlag']).toBe('1');
    expect(captured!['webSite']).toBe('1688');
  });
});

describe('getOauthTokenByAccount（旧 Alibaba.php:1601 1:1）', () => {
  function clientWithBodies(bodies: string[]): AlibabaSdkClient {
    let i = 0;
    return new AlibabaSdkClient({
      http: {
        postForm: async () => {
          const body = bodies[Math.min(i, bodies.length - 1)]!;
          i += 1;
          return { ok: true, body };
        },
      },
      now: FIXED_NOW,
    });
  }

  const IO_SAVE: string[] = [];

  it('本地缓存命中 → from=0（不调接口）', async () => {
    const client = clientWithBodies(['{}']);
    const res = await client.getOauthTokenByAccount(
      'acc1',
      { cachedToken: 'cached-token', saveToken: async () => undefined },
      CREDENTIALS,
    );
    expect(res).toEqual({ code: 200, data: { token: 'cached-token', from: 0 } });
  });

  it('list 成功 → from=1 + 回表 saveToken', async () => {
    const saved: string[] = [];
    const client = clientWithBodies([
      JSON.stringify({ returnValue: [{ accessToken: 'list-token' }] }),
    ]);
    const res = await client.getOauthTokenByAccount(
      'acc2',
      { cachedToken: null, saveToken: async (t) => saved.push(t) },
      CREDENTIALS,
    );
    expect(res).toEqual({ code: 200, data: { token: 'list-token', from: 1 } });
    expect(saved).toEqual(['list-token']);
  });

  it('list 失败 → add 兜底 → from=2', async () => {
    const client = clientWithBodies([
      JSON.stringify({ message: 'no auth' }),
      JSON.stringify({ returnValue: [{ accessToken: 'add-token' }] }),
    ]);
    const res = await client.getOauthTokenByAccount(
      'acc3',
      { cachedToken: null, saveToken: async () => undefined },
      CREDENTIALS,
    );
    expect(res).toEqual({ code: 200, data: { token: 'add-token', from: 2 } });
  });

  it('都失败 → 40000（msg 取最后一个信封）', async () => {
    const client = clientWithBodies([
      JSON.stringify({ message: 'a' }),
      JSON.stringify({ message: 'b' }),
    ]);
    const res = await client.getOauthTokenByAccount(
      'acc4',
      { cachedToken: null, saveToken: async () => undefined },
      CREDENTIALS,
    );
    expect(res.code).toBe(40000);
    expect(res.msg).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// getItemDetailFromFenxiaoApi（旧 Alibaba.php:316-376 1:1）
// ---------------------------------------------------------------------------

const FENXIAO_API = 'com.alibaba.fenxiao.crossborder/product.search.queryProductDetail';

/** 构造 fenxiao 详情成功响应体（旧网关 body 形态：result.result = 商品） */
function fenxiaoBody(result: Record<string, unknown>): string {
  return JSON.stringify({ result: { result } });
}

function fenxiaoClient(
  handler: (url: string, form: Record<string, string>) => Promise<{ ok: boolean; body: string }>,
): AlibabaSdkClient {
  return new AlibabaSdkClient({
    http: { postForm: (url, form) => handler(url, form) },
    now: FIXED_NOW,
  });
}

describe('getItemDetailFromFenxiaoApi 请求形态（旧 :326-331）', () => {
  it('API 名 + offerDetailParam{offerId:int, country:ja} + 无 token 轮换（单次请求）', async () => {
    let calls = 0;
    let captured: { url: string; form: Record<string, string> } | null = null;
    const client = fenxiaoClient(async (url, form) => {
      calls += 1;
      captured = { url, form };
      return { ok: true, body: fenxiaoBody({ offerId: 12345, subject: 'x' }) };
    });

    const res = await client.getItemDetailFromFenxiaoApi('12345', CREDENTIALS);
    expect(res.code).toBe(200);
    expect(calls).toBe(1); // fenxiao 路径无 PEMISSION_ERROR 轮换（与 getOrderDetail 不同）
    expect(captured!.url).toContain(FENXIAO_API);
    expect(captured!.url.endsWith('/1000001?')).toBe(true);
    expect(captured!.form['offerDetailParam']).toBe('{"offerId":12345,"country":"ja"}');
  });

  it('offerId 走旧 (int) 强转：12abc→12、abc→0', async () => {
    for (const [input, expected] of [
      ['12abc', 12],
      ['abc', 0],
    ] as const) {
      let form: Record<string, string> | null = null;
      const client = fenxiaoClient(async (_url, f) => {
        form = f;
        return { ok: true, body: fenxiaoBody({ offerId: 1 }) };
      });
      await client.getItemDetailFromFenxiaoApi(input, CREDENTIALS);
      expect(JSON.parse(form!['offerDetailParam']!).offerId).toBe(expected);
    }
  });

  it('空 itemId → 商品 id 有误（不打网关）', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: fenxiaoBody({ offerId: 1 }) };
    });
    const res = await client.getItemDetailFromFenxiaoApi('', CREDENTIALS);
    expect(res.code).toBe(40000);
    expect(res.msg).toBe('商品 id 有误。');
    expect(calls).toBe(0);
  });
});

describe('getItemDetailFromFenxiaoApi 信封（旧 :358-376）', () => {
  it('成功：code 200 + data.result = 商品（productSkuInfos 原样带回）', async () => {
    const product = {
      offerId: 99,
      subject: '测试商品',
      productSkuInfos: [{ skuId: 's1', skuAttributes: [{ attributeName: '颜色', value: '红' }] }],
    };
    const client = fenxiaoClient(async () => ({ ok: true, body: fenxiaoBody(product) }));
    const res = await client.getItemDetailFromFenxiaoApi('99', CREDENTIALS);
    expect(res.code).toBe(200);
    expect(res.data.result).toEqual(product);
  });

  it('失败：result.result 空 → 40000，msg = result.message ?? 商品可能不存在。', async () => {
    const client = fenxiaoClient(async () => ({
      ok: true,
      body: JSON.stringify({ result: { message: 'offer 不存在' } }),
    }));
    const res = await client.getItemDetailFromFenxiaoApi('7', CREDENTIALS);
    expect(res.code).toBe(40000);
    expect(res.msg).toBe('offer 不存在');
    expect(res.resp).toEqual({ result: { message: 'offer 不存在' } });

    // 无 message ⇒ 默认文案
    const client2 = fenxiaoClient(async () => ({ ok: true, body: JSON.stringify({ result: {} }) }));
    const res2 = await client2.getItemDetailFromFenxiaoApi('7', CREDENTIALS);
    expect(res2.code).toBe(40000);
    expect(res2.msg).toBe('商品可能不存在。');
  });

  it('响应体非 JSON / 空体 → 解码失败同义 40000 默认文案', async () => {
    const client = fenxiaoClient(async () => ({ ok: true, body: 'not-json' }));
    const res = await client.getItemDetailFromFenxiaoApi('7', CREDENTIALS);
    expect(res.code).toBe(40000);
    expect(res.msg).toBe('商品可能不存在。');
  });
});

describe('fillMissingSkuInfos（旧 EnsureAlibabaProductSkuInfosService 1:1）', () => {
  it('已有 productSkuInfos ⇒ 原样返回（不补）', () => {
    const product = { offerId: 1, productSkuInfos: [{ skuId: 's' }] };
    expect(fillMissingSkuInfos(product)).toBe(product); // 同一引用，旧 return $product
  });

  it('缺 productSkuInfos ⇒ 补默认 SKU（skuId=offerId，規格:デフォルト）', () => {
    const filled = fillMissingSkuInfos({ offerId: '555', productCargoNumber: 'CN-1' });
    const sku = filled['productSkuInfos'] as Array<Record<string, unknown>>;
    expect(sku).toHaveLength(1);
    expect(sku[0]!['skuId']).toBe('555');
    expect(sku[0]!['cargoNumber']).toBe('CN-1');
    expect(sku[0]!['skuAttributes']).toEqual([
      {
        attributeId: 0,
        attributeName: '规格',
        attributeNameTrans: '規格',
        value: '默认',
        valueTrans: 'デフォルト',
        skuImageUrl: '',
      },
    ]);
  });

  it('批发价解析链：price → consignPrice → fenxiao.offerPrice → priceRangeList[0]', () => {
    const skuOf = (saleInfo: Record<string, unknown>): unknown =>
      (
        fillMissingSkuInfos({ offerId: 1, productSaleInfo: saleInfo })['productSkuInfos'] as Array<
          Record<string, unknown>
        >
      )[0]!['price'];

    expect(skuOf({ price: 12.5 })).toBe(12.5);
    expect(skuOf({ price: 0, consignPrice: '9.90' })).toBe('9.90'); // 旧 ==0 松比较：'0' 也过
    expect(skuOf({ price: '0', consignPrice: 0, fenxiaoSaleInfo: { offerPrice: 7 } })).toBe(7);
    expect(skuOf({ price: 0, consignPrice: 0, priceRangeList: [{ price: 3.3 }] })).toBe(3.3);
  });

  it('默认 SKU 的规格取 productAttribute 首条完整属性（含 trans 回退）', () => {
    const filled = fillMissingSkuInfos({
      offerId: 1,
      productAttribute: [
        { attributeName: '   ', value: 'x' }, // 空 name 跳过
        { attributeName: 'サイズ', value: 'M' }, // 首条完整属性
        { attributeName: '色', value: '赤' },
      ],
      productImage: { images: ['img-1.jpg'] },
    });
    const sku = (filled['productSkuInfos'] as Array<Record<string, unknown>>)[0]!;
    expect(sku['skuAttributes']).toEqual([
      {
        attributeId: 0,
        attributeName: 'サイズ',
        attributeNameTrans: 'サイズ', // 无 trans ⇒ 回退原名
        value: 'M',
        valueTrans: 'M',
        skuImageUrl: 'img-1.jpg',
      },
    ]);
  });
});

describe('getItemDetailFromFenxiaoApi 缓存（旧 :333-356，1h TTL）', () => {
  it('第一次打网关并落缓存；第二次命中缓存不再打网关', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: fenxiaoBody({ offerId: 42, subject: 's' }) };
    });
    const cache = createInMemoryTtlCache();

    const r1 = await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);
    expect(r1.code).toBe(200);
    expect(calls).toBe(1);

    const r2 = await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);
    expect(r2.code).toBe(200);
    expect(calls).toBe(1); // 缓存命中，未再打网关
    expect(r2).toEqual(r1);

    // 旧 put 的值 = 原始响应体串（key 前缀 + 凭证 md5 + itemId）
    const salt = createHash('md5')
      .update(JSON.stringify({ appid: '1000001', appkey: 'test-appkey', token: 'test-token' }))
      .digest('hex');
    expect(await cache.get(`1688-kj-detial-use-fenxiao-api${salt}42`)).toBe(
      fenxiaoBody({ offerId: 42, subject: 's' }),
    );
  });

  it('★ 守卫：失败响应（result.result 空）不落缓存——下次仍会打网关', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: JSON.stringify({ result: {} }) };
    });
    const cache = createInMemoryTtlCache();

    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);
    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);
    expect(calls).toBe(2);
  });

  it('useCache=false ⇒ 先 forget 再直查（缓存有值也打网关）', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: fenxiaoBody({ offerId: 42 }) };
    });
    const cache = createInMemoryTtlCache();
    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);
    expect(calls).toBe(1);

    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache, false);
    expect(calls).toBe(2); // 旧 Cache::forget 后重查

    // forget 后再 get = null（旧 forget 语义）
    const salt = createHash('md5')
      .update(JSON.stringify({ appid: '1000001', appkey: 'test-appkey', token: 'test-token' }))
      .digest('hex');
    expect(await cache.get(`1688-kj-detial-use-fenxiao-api${salt}42`)).not.toBeNull(); // 重查成功后重新 put
  });

  it('缓存 key 含凭证（不同凭证不同 key，互不污染）', async () => {
    const client = fenxiaoClient(async () => ({ ok: true, body: fenxiaoBody({ offerId: 42 }) }));
    const cache = createInMemoryTtlCache();
    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);

    const saltA = createHash('md5')
      .update(JSON.stringify({ appid: '1000001', appkey: 'test-appkey', token: 'test-token' }))
      .digest('hex');
    const saltB = createHash('md5')
      .update(JSON.stringify({ appid: '1000001', appkey: 'test-appkey', token: 'other-token' }))
      .digest('hex');
    expect(saltA).not.toBe(saltB);
    expect(await cache.get(`1688-kj-detial-use-fenxiao-api${saltA}42`)).not.toBeNull();
    expect(await cache.get(`1688-kj-detial-use-fenxiao-api${saltB}42`)).toBeNull();
  });

  it('无 cache ⇒ 每次直查（不炸）', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: fenxiaoBody({ offerId: 42 }) };
    });
    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS);
    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// searchSellerOpenIdByGoodsId / decryptWangwangNick
// （旧 Alibaba.php:221-252 / 582-602 1:1）
// ---------------------------------------------------------------------------

describe('searchSellerOpenIdByGoodsId（旧 :221-252，⚠ 返回 sellerOpenId 非店铺名）', () => {
  it('同 fenxiao 详情 API 同参；取 result.result.sellerOpenId', async () => {
    let captured: { url: string; form: Record<string, string> } | null = null;
    const client = fenxiaoClient(async (url, form) => {
      captured = { url, form };
      return { ok: true, body: fenxiaoBody({ offerId: 42, sellerOpenId: 'oid-abc' }) };
    });

    const value = await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS);
    expect(value).toBe('oid-abc');
    expect(captured!.url).toContain(`/${FENXIAO_API}/`);
    // 旧 (int) 强转：'42' → 42；offerDetailParam 序列化形态同详情方法
    expect(captured!.form['offerDetailParam']).toBe('{"offerId":42,"country":"ja"}');
  });

  it('offerId int 强转（123abc→123 / 非数值→0），与详情方法同规', async () => {
    const forms: Array<Record<string, string>> = [];
    const client = fenxiaoClient(async (_url, form) => {
      forms.push(form);
      return { ok: true, body: fenxiaoBody({ sellerOpenId: 'x' }) };
    });
    await client.searchSellerOpenIdByGoodsId('123abc', CREDENTIALS);
    await client.searchSellerOpenIdByGoodsId('abc', CREDENTIALS);
    expect(forms[0]!['offerDetailParam']).toBe('{"offerId":123,"country":"ja"}');
    expect(forms[1]!['offerDetailParam']).toBe('{"offerId":0,"country":"ja"}');
  });

  it('useCache=true：remember 语义——命中不打网关；失败的空串也入缓存', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      // 网关错误信封（无 result.result）⇒ 旧闭包返回 null ⇒ 缓存 ''
      return { ok: true, body: JSON.stringify({ result: { message: '商品不存在' } }) };
    });
    const cache = createInMemoryTtlCache();

    expect(await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache)).toBe('');
    expect(await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache)).toBe('');
    expect(calls).toBe(1); // 第二次命中缓存的 ''（旧 Cache::remember 存闭包返回值）
  });

  it('useCache=false：不读缓存 + 仅非空才 put', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: JSON.stringify({ result: { message: 'boom' } }) };
    });
    const cache = createInMemoryTtlCache();

    expect(await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache, false)).toBe('');
    // 失败响应不入缓存 ⇒ 关缓存再查仍打网关
    expect(await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache, false)).toBe('');
    expect(calls).toBe(2);

    // 成功响应（非空）才 put
    const okClient = fenxiaoClient(async () => ({
      ok: true,
      body: fenxiaoBody({ sellerOpenId: 'oid-1' }),
    }));
    expect(await okClient.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache, false)).toBe(
      'oid-1',
    );
    // put 之后再关缓存查——useCache=false 仍不读缓存（旧 else 分支语义）
    expect(await okClient.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache, false)).toBe(
      'oid-1',
    );
  });

  it('缓存键 = generateCacheKey 方案（与详情方法 1688-kj-detial 前缀方案不共享）', async () => {
    const client = fenxiaoClient(async () => ({
      ok: true,
      body: fenxiaoBody({ offerId: 42, sellerOpenId: 'oid-shared' }),
    }));
    const cache = createInMemoryTtlCache();

    // 详情方法先写它的键
    await client.getItemDetailFromFenxiaoApi('42', CREDENTIALS, cache);
    // 店铺反解用另一套键 ⇒ 仍然打网关（cache miss），证明两套键共存不互相污染
    let searchCalls = 0;
    const searchClient = fenxiaoClient(async () => {
      searchCalls += 1;
      return { ok: true, body: fenxiaoBody({ sellerOpenId: 'oid-shared' }) };
    });
    await searchClient.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache);
    expect(searchCalls).toBe(1);
    // 但自己的键第二次命中
    await searchClient.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache);
    expect(searchCalls).toBe(1);
  });

  it('凭证分 key（salt 不同 ⇒ 不共享缓存）', async () => {
    const cache = createInMemoryTtlCache();
    const client = fenxiaoClient(async () => ({
      ok: true,
      body: fenxiaoBody({ sellerOpenId: 'oid' }),
    }));
    const other: AlibabaSdkCredentials = { ...CREDENTIALS, token: 'other-token' };
    await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache);
    let otherCalls = 0;
    const otherClient = fenxiaoClient(async () => {
      otherCalls += 1;
      return { ok: true, body: fenxiaoBody({ sellerOpenId: 'oid' }) };
    });
    await otherClient.searchSellerOpenIdByGoodsId('42', other, cache);
    expect(otherCalls).toBe(1);
  });

  it("PHP empty() 松判空：sellerOpenId='0' 在 useCache=false 分支归空串且不缓存", async () => {
    const client = fenxiaoClient(async () => ({
      ok: true,
      body: fenxiaoBody({ sellerOpenId: '0' }),
    }));
    const cache = createInMemoryTtlCache();
    // useCache=true 分支旧代码直接返回（'0' 原样）
    expect(await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache)).toBe('0');
    // useCache=false 分支旧代码 empty('0') → '' 且不 put
    expect(await client.searchSellerOpenIdByGoodsId('42', CREDENTIALS, cache, false)).toBe('');
  });
});

describe('decryptWangwangNick（旧 :582-602，无缓存 + 异常吞掉返空）', () => {
  it('API + openUid 入参；取 wangwangNick', async () => {
    let captured: { url: string; form: Record<string, string> } | null = null;
    const client = fenxiaoClient(async (url, form) => {
      captured = { url, form };
      return { ok: true, body: JSON.stringify({ wangwangNick: '旺旺昵称' }) };
    });

    const value = await client.decryptWangwangNick('openid-xyz', CREDENTIALS);
    expect(value).toBe('旺旺昵称');
    expect(captured!.url).toContain('/com.alibaba.account/wangwangnick.openuid.decrypt/');
    expect(captured!.form['openUid']).toBe('openid-xyz');
  });

  it("网关错误信封 / 超时信封 → 空串（旧 catch → '' 同义）", async () => {
    const errClient = fenxiaoClient(async () => ({
      ok: true,
      body: JSON.stringify({ message: '解密失败' }),
    }));
    expect(await errClient.decryptWangwangNick('oid', CREDENTIALS)).toBe('');

    // execute 内部 catch 网络异常 → 超时信封（resp 有 message、无 wangwangNick）
    const timeoutClient = fenxiaoClient(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await timeoutClient.decryptWangwangNick('oid', CREDENTIALS)).toBe('');
  });

  it('空 openid → 空串且不打网关（旧 empty 分支的端口层收敛，不可达路径）', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: JSON.stringify({ wangwangNick: 'x' }) };
    });
    expect(await client.decryptWangwangNick('', CREDENTIALS)).toBe('');
    expect(calls).toBe(0);
  });

  it('无缓存：同一 openid 重复调用每次都打网关（旧方法不缓存 1:1）', async () => {
    let calls = 0;
    const client = fenxiaoClient(async () => {
      calls += 1;
      return { ok: true, body: JSON.stringify({ wangwangNick: 'n' }) };
    });
    await client.decryptWangwangNick('oid', CREDENTIALS);
    await client.decryptWangwangNick('oid', CREDENTIALS);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createOrder（旧 Alibaba.php:934-1003 1:1，chrome ACTION_CREATE_1688_ORDER(8) SDK 面）
// ---------------------------------------------------------------------------

describe('createOrder（旧 :934-1003）', () => {
  function fakeHttp(
    handler: (url: string, form: Record<string, string>) => Promise<{ ok: boolean; body: string }>,
  ): AlibabaHttpPort {
    return { postForm: (url, form) => handler(url, form) };
  }

  it('默认参数形态：flow=general / tradeType=fxassure / anonymousBuyer(串) + 数组 JSON 化', async () => {
    let captured: { url: string; form: Record<string, string> } | null = null;
    const client = new AlibabaSdkClient({
      http: fakeHttp(async (url, form) => {
        captured = { url, form };
        return {
          ok: true,
          body: JSON.stringify({ success: { orderId: '99' }, result: { orderId: '99' } }),
        };
      }),
      now: FIXED_NOW,
    });

    await client.createOrder(
      { fullName: '张三', mobile: '138' },
      [{ offerId: 42, quantity: 2 }],
      { useRedEnvelope: 'n' },
      CREDENTIALS,
    );

    expect(captured!.url).toContain('/com.alibaba.trade/alibaba.trade.createCrossOrder/');
    expect(captured!.form['flow']).toBe('general'); // 旧 self::GENERAL
    expect(captured!.form['tradeType']).toBe('fxassure');
    expect(captured!.form['anonymousBuyer']).toBe('true'); // 字符串非 bool
    expect(captured!.form['useRedEnvelope']).toBe('n');
    expect(JSON.parse(captured!.form['addressParam']!)).toEqual({
      fullName: '张三',
      mobile: '138',
    });
    expect(captured!.form['cargoParamList']).toBe('[{"offerId":42,"quantity":2}]');
  });

  it('extra 覆盖默认键（旧 array_merge 语义）', async () => {
    let form: Record<string, string> | null = null;
    const client = new AlibabaSdkClient({
      http: fakeHttp(async (_url, f) => {
        form = f;
        return { ok: true, body: JSON.stringify({ success: 1, result: {} }) };
      }),
      now: FIXED_NOW,
    });
    await client.createOrder(
      {},
      [],
      { tradeType: 'fxassure2', message: '请尽快发货' },
      CREDENTIALS,
    );
    expect(form!['tradeType']).toBe('fxassure2');
    expect(form!['message']).toBe('请尽快发货');
  });

  it("pre_create 真值切预览 API；PHP truthy——'false' 字符串也算真", async () => {
    const urls: string[] = [];
    const client = new AlibabaSdkClient({
      http: fakeHttp(async (url) => {
        urls.push(url);
        return {
          ok: true,
          body: JSON.stringify({ success: 1, orderPreviewResuslt: { preview: true } }),
        };
      }),
      now: FIXED_NOW,
    });
    await client.createOrder({}, [], { pre_create: 'true' }, CREDENTIALS);
    await client.createOrder({}, [], { pre_create: 'false' }, CREDENTIALS);
    await client.createOrder({}, [], { pre_create: '0' }, CREDENTIALS); // PHP falsy

    expect(urls[0]).toContain('/com.alibaba.trade/alibaba.createOrder.preview/');
    expect(urls[1]).toContain('/com.alibaba.trade/alibaba.createOrder.preview/'); // 'false' PHP truthy
    expect(urls[2]).toContain('/com.alibaba.trade/alibaba.trade.createCrossOrder/');
  });

  it('成功信封：200 → data.result；预览 → orderPreviewResuslt（旧拼写 typo 1:1）', async () => {
    const okClient = new AlibabaSdkClient({
      http: fakeHttp(async () => ({
        ok: true,
        body: JSON.stringify({ success: { orderId: '77' }, result: { orderId: '77' } }),
      })),
      now: FIXED_NOW,
    });
    const res = await okClient.createOrder({}, [], {}, CREDENTIALS);
    expect(res).toEqual({ code: 200, data: { orderId: '77' } });

    const previewClient = new AlibabaSdkClient({
      http: fakeHttp(async () => ({
        ok: true,
        body: JSON.stringify({ success: 1, orderPreviewResuslt: { preview: 'x' } }),
      })),
      now: FIXED_NOW,
    });
    const pre = await previewClient.createOrder({}, [], { pre_create: 1 }, CREDENTIALS);
    expect(pre).toEqual({ code: 200, data: { preview: 'x' } });
  });

  it("success 非空判定（PHP empty）：'0'/[]/0 不算成功，走错误分支", async () => {
    for (const successValue of ['0', 0, [], '']) {
      const client = new AlibabaSdkClient({
        http: fakeHttp(async () => ({
          ok: true,
          body: JSON.stringify({ success: successValue, message: 'boom' }),
        })),
        now: FIXED_NOW,
      });
      const res = await client.createOrder({}, [], {}, CREDENTIALS);
      expect(res.code).toBe(40000);
      expect(res.code === 40000 && res.msg).toBe('boom');
    }
  });

  it("授权失效专项：error_message == 'Request need user authorized'", async () => {
    const client = new AlibabaSdkClient({
      http: fakeHttp(async () => ({
        ok: true,
        body: JSON.stringify({ error_message: 'Request need user authorized', message: 'other' }),
      })),
      now: FIXED_NOW,
    });
    const res = await client.createOrder({}, [], {}, CREDENTIALS);
    expect(res).toEqual({
      code: 40000,
      msg: '采购账号授权失效，需要刷新授权',
      resp: { error_message: 'Request need user authorized', message: 'other' },
    });
  });

  it('msg 兜底链：message → errorMsg → error_message（Arr::get 默认值语义）', async () => {
    const bodies = [
      { message: 'm1' },
      { errorMsg: 'm2' },
      { error_message: 'm3' },
      { message: null }, // key 存在但 null → 信封 msg 缺省（旧 Arr::get 存在即返回）
      {},
    ];
    const expects = ['m1', 'm2', 'm3', undefined, undefined];
    for (let i = 0; i < bodies.length; i += 1) {
      const body = bodies[i]!;
      const client = new AlibabaSdkClient({
        http: fakeHttp(async () => ({ ok: true, body: JSON.stringify(body) })),
        now: FIXED_NOW,
      });
      const res = await client.createOrder({}, [], {}, CREDENTIALS);
      expect(res.code).toBe(40000);
      expect(res.code === 40000 ? res.msg : 'x').toBe(expects[i]);
    }
  });

  it('网络异常 → execute 超时信封 → msg = 接口超时文案', async () => {
    const client = new AlibabaSdkClient({
      http: fakeHttp(async () => {
        throw new Error('ECONNRESET');
      }),
      now: FIXED_NOW,
    });
    const res = await client.createOrder({}, [], {}, CREDENTIALS);
    expect(res.code).toBe(40000);
    expect(res.code === 40000 && res.msg).toBe('接口超时，请稍后重试！');
  });
});
