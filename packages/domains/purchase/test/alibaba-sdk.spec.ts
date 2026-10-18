import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AlibabaSdkClient,
  type AlibabaHttpPort,
  type AlibabaSdkCredentials,
} from '../src/alibaba-sdk';

/**
 * 1688 SDK 纯逻辑用例（不触 DB / 不打真网关）：
 *   ① 签名：ksort 顺序、毫秒时间戳、HMAC-SHA1 大写 hex、签名原文含 fullApi/appid
 *   ② execute：数组 json_encode、null 剔除、网络失败 → 超时信封
 *   ③ getOrderDetail：result 提取（PHP !empty 口径）、PEMISSION_ERROR 单跳轮换、
 *      非权限错不轮换、msg 拼接、空凭证链直落信封
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
