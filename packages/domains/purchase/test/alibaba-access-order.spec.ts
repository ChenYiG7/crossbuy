import { describe, expect, it } from 'vitest';
import { AlibabaAccessServiceImpl, type AlibabaAccessDeps } from '../src/alibaba-access';
import {
  AlibabaSdkClient,
  type AlibabaHttpPort,
  type AlibabaSdkCredentials,
} from '../src/alibaba-sdk';

/**
 * createCrossOrderByAccount 编排用例（旧 OrderController::create1688Order
 * Http/Controllers/Api/OrderController.php:363-445 1:1）。
 *
 * 整链 fake：deps + 网关 http（不打真 1688）。核心验证：
 * ① 三个/四个 400 参数错误分支与**旧顺序**（accountName → addressInfo → token → itemInfo）
 * ② token 覆写：建单网关调用的 access_token = 子账号解析出的 token（非主组 env token）
 * ③ 多 shop 累计：一成一败 → 200 + success/errors（不中断）
 * ④ SDK 抛错 → '下单异常：' 进 errors（旧 catch Throwable）
 * ⑤ useRedEnvelope='n' 固定 + message 透传
 */

const ENV: Record<string, string> = {
  ALIBABA_FENXIAO_APPID: 'appid-main',
  ALIBABA_FENXIAO_APPKEY: 'appkey-main',
  ALIBABA_FENXIAO_TOKEN: 'token-main-env',
};

function makeDeps(overrides: Partial<AlibabaAccessDeps> = {}): AlibabaAccessDeps {
  return {
    findAutoCreatedSubAccountId: async () => null,
    findSubAccountById: async () => null,
    // 本地缓存行带 accessToken ⇒ getOauthTokenByAccount 直取缓存不打网关（旧缓存路径）
    findSubAccountByUsername: async () => ({
      id: 7,
      username: 'acc1',
      token: JSON.stringify({ accessToken: 'token-from-account' }),
    }),
    upsertSubAccountToken: async () => undefined,
    envGet: (key) => ENV[key],
    ...overrides,
  };
}

/** 记录每次网关调用的 url/form */
function recordingHttp(
  handler: (url: string, form: Record<string, string>) => Promise<{ ok: boolean; body: string }>,
): { port: AlibabaHttpPort; calls: Array<{ url: string; form: Record<string, string> }> } {
  const calls: Array<{ url: string; form: Record<string, string> }> = [];
  const port: AlibabaHttpPort = {
    postForm: async (url, form) => {
      calls.push({ url, form });
      return handler(url, form);
    },
  };
  return { port, calls };
}

const ADDRESS = { fullName: '张三', mobile: '13800000000' };
const ITEMS = [{ offerId: 42, quantity: 2 }];

describe('createCrossOrderByAccount（旧 OrderController:363-445 编排）', () => {
  it('accountName 空 → 400「参数错误，请检查下单账号」（不打网关）', async () => {
    const { port, calls } = recordingHttp(async () => ({ ok: true, body: '{}' }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: '',
      addressInfo: ADDRESS,
      itemInfo: [{ shopId: 1, items: ITEMS }],
    });
    expect(res).toEqual({ code: 400, msg: '参数错误，请检查下单账号' });
    expect(calls).toHaveLength(0);
  });

  it('addressInfo 空 → 400「参数错误，请检查收件人地址信息」', async () => {
    const { port, calls } = recordingHttp(async () => ({ ok: true, body: '{}' }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: null,
      itemInfo: [{ shopId: 1, items: ITEMS }],
    });
    expect(res).toEqual({ code: 400, msg: '参数错误，请检查收件人地址信息' });
    expect(calls).toHaveLength(0);
  });

  it('token 解析失败 → 400「您指定的子账号没有下单权限，请联系管理员处理。」', async () => {
    // 无缓存行 + 无 env ⇒ getOauthTokenByAccount 直落 40000（access 层译成 400）
    const { port } = recordingHttp(async () => ({ ok: true, body: '{}' }));
    const access = new AlibabaAccessServiceImpl(
      makeDeps({ findSubAccountByUsername: async () => null }),
      new AlibabaSdkClient({ http: port }),
    );
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [{ shopId: 1, items: ITEMS }],
    });
    expect(res).toEqual({ code: 400, msg: '您指定的子账号没有下单权限，请联系管理员处理。' });
  });

  it('itemInfo 空 → 400「参数错误，未获取到商品信息」（校验在 token 解析**之后**，顺序 1:1）', async () => {
    const { port, calls } = recordingHttp(async () => ({ ok: true, body: '{}' }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [],
    });
    expect(res).toEqual({ code: 400, msg: '参数错误，未获取到商品信息' });
    expect(calls).toHaveLength(0); // token 走缓存路径不打网关，未到建单
  });

  it('成功路径：token 覆写进建单凭证（access_token = 子账号 token，非主组 env）', async () => {
    const { port, calls } = recordingHttp(async () => ({
      ok: true,
      body: JSON.stringify({ success: { orderId: 'A1' }, result: { orderId: 'A1' } }),
    }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [{ shopId: 1, shopName: '店铺一', items: ITEMS }],
    });

    expect(res.code).toBe(200);
    if (res.code !== 200) return;
    expect(res.data.errors).toHaveLength(0);
    expect(res.data.success).toHaveLength(1);
    expect(res.data.success[0]).toMatchObject({ shopId: 1, shopName: '店铺一' });

    // 建单调用的 access_token = 子账号解析值（旧 $sdk->sdkInitParam['token'] = $token）
    const createCall = calls.find((c) => c.url.includes('createCrossOrder'));
    expect(createCall).toBeDefined();
    expect(createCall!.form['access_token']).toBe('token-from-account');
    // 主组 appid/appkey 不变（旧换的只是 token）
    expect(createCall!.url).toContain('/appid-main?');
    // useRedEnvelope='n' 固定
    expect(createCall!.form['useRedEnvelope']).toBe('n');
  });

  it('message 非空透传进 extra；空则不出现', async () => {
    const bodies = ['请尽快发货', null, ''];
    for (const message of bodies) {
      const { port, calls } = recordingHttp(async () => ({
        ok: true,
        body: JSON.stringify({ success: 1, result: {} }),
      }));
      const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
      await access.createCrossOrderByAccount({
        accountName: 'acc1',
        addressInfo: ADDRESS,
        itemInfo: [{ shopId: 1, items: ITEMS }],
        message,
      });
      const createCall = calls.find((c) => c.url.includes('createCrossOrder'))!;
      if (message) expect(createCall.form['message']).toBe(message);
      else expect('message' in createCall.form).toBe(false); // PHP empty 剔除
    }
  });

  it('多 shop：一成一败 → 200 + 各累计一项（不中断后续 shop）', async () => {
    const { port, calls } = recordingHttp(async (_url, form) => {
      // 第一个 shop 成功，第二个失败（用 cargo 里的 offerId 区分）
      const cargo = JSON.parse(form['cargoParamList']!) as Array<{ offerId: number }>;
      if (cargo[0]!.offerId === 42) {
        return {
          ok: true,
          body: JSON.stringify({ success: { orderId: 'A1' }, result: { orderId: 'A1' } }),
        };
      }
      return { ok: true, body: JSON.stringify({ error_message: '库存不足' }) };
    });
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [
        { shopId: 1, shopName: '店铺一', items: [{ offerId: 42 }] },
        { shopId: 2, shopName: '店铺二', items: [{ offerId: 43 }] },
      ],
    });

    expect(res.code).toBe(200);
    if (res.code !== 200) return;
    expect(res.data.success).toHaveLength(1);
    expect(res.data.success[0]!.shopId).toBe(1);
    // errors.msg = 信封 msg（error_message 兜底链第三级）
    expect(res.data.errors).toHaveLength(1);
    expect(res.data.errors[0]).toMatchObject({ shopId: 2, shopName: '店铺二', msg: '库存不足' });
    expect(calls.filter((c) => c.url.includes('createCrossOrder'))).toHaveLength(2);
  });

  it('SDK 抛错（client 层异常）→『下单异常：』进 errors，不中断', async () => {
    const throwingClient = {
      createOrder: async () => {
        throw new Error('socket hang up');
      },
      getOauthTokenByAccount: async () => ({
        code: 200,
        data: { token: 'token-from-account', from: 0 as const },
      }),
    } as unknown as AlibabaSdkClient;
    const { port } = recordingHttp(async () => ({ ok: true, body: '{}' }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), throwingClient);
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [{ shopId: 9, shopName: '店铺九', items: ITEMS }],
    });
    expect(res.code).toBe(200);
    if (res.code !== 200) return;
    expect(res.data.success).toHaveLength(0);
    expect(res.data.errors).toEqual([
      { shopId: 9, shopName: '店铺九', msg: '下单异常：socket hang up' },
    ]);
    expect(port).toBeDefined();
  });

  it('信封失败无 msg → errors.msg = 『未知错误』（旧 ?? 兜底）', async () => {
    const { port } = recordingHttp(async () => ({
      ok: true,
      body: JSON.stringify({ error_code: 123 }),
    }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [{ shopId: 3, shopName: 's', items: ITEMS }],
    });
    expect(res.code).toBe(200);
    if (res.code !== 200) return;
    expect(res.data.errors[0]!.msg).toBe('未知错误');
  });

  it('itemInfo 非数组（旧 PHP foreach warning 不迭代）→ 200 空 success/errors', async () => {
    const { port, calls } = recordingHttp(async () => ({ ok: true, body: '{}' }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    const res = await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: 'not-an-array',
    });
    expect(res).toEqual({ code: 200, data: { success: [], errors: [] } });
    expect(calls).toHaveLength(0);
  });

  it('凭证逐请求一致：每个 shop 的建单都用同一个覆写 token', async () => {
    const { port, calls } = recordingHttp(async () => ({
      ok: true,
      body: JSON.stringify({ success: 1, result: {} }),
    }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [
        { shopId: 1, items: ITEMS },
        { shopId: 2, items: ITEMS },
        { shopId: 3, items: ITEMS },
      ],
    });
    const tokens = calls
      .filter((c) => c.url.includes('createCrossOrder'))
      .map((c) => c.form['access_token']);
    expect(tokens).toEqual(['token-from-account', 'token-from-account', 'token-from-account']);
  });
});

describe('AlibabaSdkCredentials 形状（编译期守型）', () => {
  it('access 服务输出的覆写凭证只换 token 不动 appid/appkey', async () => {
    const { port, calls } = recordingHttp(async () => ({
      ok: true,
      body: JSON.stringify({ success: 1, result: {} }),
    }));
    const access = new AlibabaAccessServiceImpl(makeDeps(), new AlibabaSdkClient({ http: port }));
    await access.createCrossOrderByAccount({
      accountName: 'acc1',
      addressInfo: ADDRESS,
      itemInfo: [{ shopId: 1, items: ITEMS }],
    });
    const call = calls.find((c) => c.url.includes('createCrossOrder'))!;
    const expected: Pick<AlibabaSdkCredentials, 'appid' | 'appkey'> = {
      appid: 'appid-main',
      appkey: 'appkey-main',
    };
    expect(call.url).toContain(`/${expected.appid}?`);
    expect(call.form['access_token']).toBe('token-from-account');
  });
});
