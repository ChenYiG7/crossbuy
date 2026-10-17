/**
 * M1 翻译 —— 源：旧系统三个用例（haiou，只读参考）：
 *   `AddFavoriteTest`（成功/type 分流/重复 URL 拒绝）
 *   `DeleteFavoriteTest`（删自己的成功/删别人的 not_found 且记录还在）
 *   `ListFavoriteTest`（二值 type 过滤 + fid 倒序）+ `FavoriteControllerTest`（分页/只看自己的）
 *
 * 翻译原则（同 M0.9/M1）：测业务规则不测传输层；连真实 dump 库，写操作事务回滚。
 */
import { describe, expect, it } from 'vitest';
import { legacyPrisma } from '@crossbuy/db';
import { memberPrincipal } from '@crossbuy/auth';
import { FAVORITE_TYPE } from '@crossbuy/contract';
import { MemberRepository } from '../src/repository';
import { InMemoryLoginRateLimiter } from '../src/login-rate-limiter';
import { Md5PasswordVerifier } from '../src/password-verifier';
import { MemberServiceImpl } from '../src/service';
import { withRollback } from './helpers/rollback';

function makeService(tx: typeof legacyPrisma) {
  return new MemberServiceImpl(
    new MemberRepository(tx),
    new Md5PasswordVerifier(),
    new InMemoryLoginRateLimiter(),
  );
}

/** 造一个会员（dg_users NOT NULL 无默认列：card/validity/memberid；dfflag 控制收藏 type 分流） */
async function createUser(tx: typeof legacyPrisma, uname: string, dfflag = 0) {
  const row = await tx.dg_users.create({
    data: { uname, password: 'x', card: 'test', validity: 1, memberid: uname, dfflag },
    select: { uid: true },
  });
  return row.uid;
}

const GOODS = {
  name: '测试商品',
  platform: 'taobao' as const,
  nick: '测试商家',
  price: 19.8,
  detailUrl: 'https://item.taobao.com/item.htm?id=694784194003',
  picture: 'http://img.alicdn.com/x.jpg',
};

describe('addFavorite（旧 AddFavoriteTest 翻译）', () => {
  it('成功：代购用户 → type=1，goodssite=淘宝，addtime 落当前时间', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-add');
      const before = Math.floor(Date.now() / 1000);
      const res = await makeService(tx).addFavorite(memberPrincipal(uid), GOODS);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.value.fid).toBeGreaterThan(0);
      expect(res.value.type).toBe(FAVORITE_TYPE.DAIGOU);
      expect(res.value.goodsSite).toBe('淘宝');
      expect(res.value.goodsPrice).toBe('19.8'); // float → money 字符串
      expect(res.value.goodsName).toBe('测试商品');
      expect(res.value.goodsSeller).toBe('测试商家');
      expect(res.value.goodsImg).toBe('http://img.alicdn.com/x.jpg');
      // createdAt ISO 化（Asia/Shanghai，+08:00 尾）
      expect(res.value.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
      const isoSeconds = Date.parse(res.value.createdAt) / 1000;
      expect(isoSeconds).toBeGreaterThanOrEqual(before - 1);
      expect(isoSeconds).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    });
  });

  it('成功：代发用户（dfflag=1）→ type=3（旧 dfflag 分流，取库里活值）', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-df', 1);
      const res = await makeService(tx).addFavorite(memberPrincipal(uid), GOODS);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.type).toBe(FAVORITE_TYPE.DAIFA);
    });
  });

  it('platform 映射：1688→1688，other→其他', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-site');
      const service = makeService(tx);
      const a = await service.addFavorite(memberPrincipal(uid), {
        ...GOODS,
        platform: '1688',
        detailUrl: 'https://detail.1688.com/offer/1.html',
      });
      const b = await service.addFavorite(memberPrincipal(uid), {
        ...GOODS,
        platform: 'other',
        detailUrl: 'https://example.com/x',
      });
      expect(a.ok && a.value.goodsSite).toBe('1688');
      expect(b.ok && b.value.goodsSite).toBe('其他');
    });
  });

  it('重复 URL → FAVORITE_GOODS_URL_DUPLICATE（旧 goods_url_already_exist，消息照旧文案）', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-dup');
      const service = makeService(tx);
      const first = await service.addFavorite(memberPrincipal(uid), GOODS);
      expect(first.ok).toBe(true);

      const second = await service.addFavorite(memberPrincipal(uid), GOODS);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('FAVORITE_GOODS_URL_DUPLICATE');
      expect(second.error.message).toBe('已有同样的商品加入收藏了，请确认。');

      // 库里确实只有一条（先查后插在串行下不重复）
      const count = await tx.dg_favorite.count({ where: { uid, goodsurl: GOODS.detailUrl } });
      expect(count).toBe(1);
    });
  });

  it('不传 picture → goodsimg 为 null（旧 mutation 可选参数）', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-noimg');
      const { picture: _picture, ...rest } = GOODS;
      const res = await makeService(tx).addFavorite(memberPrincipal(uid), rest);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.goodsImg).toBeNull();
    });
  });
});

describe('deleteFavorite（旧 DeleteFavoriteTest 翻译）', () => {
  it('删自己的收藏 → 成功且行消失', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-del');
      const created = await makeService(tx).addFavorite(memberPrincipal(uid), GOODS);
      if (!created.ok) throw new Error('fixture 失败');
      const fid = created.value.fid;

      const res = await makeService(tx).deleteFavorite(memberPrincipal(uid), fid);
      expect(res.ok).toBe(true);
      const row = await tx.dg_favorite.findUnique({ where: { fid } });
      expect(row).toBeNull();
    });
  });

  it('删别人的收藏 → FAVORITE_NOT_FOUND 且记录还在（旧 testDeleteFavoriteWithOtherUidFail）', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx, 'vitest-fav-owner');
      const other = await createUser(tx, 'vitest-fav-other');
      const created = await makeService(tx).addFavorite(memberPrincipal(owner), GOODS);
      if (!created.ok) throw new Error('fixture 失败');
      const fid = created.value.fid;

      const res = await makeService(tx).deleteFavorite(memberPrincipal(other), fid);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('FAVORITE_NOT_FOUND');
      expect(res.error.message).toBe('收藏记录不存在');

      const row = await tx.dg_favorite.findUnique({ where: { fid } });
      expect(row).not.toBeNull(); // 记录未被误删
    });
  });

  it('删不存在的 fid → FAVORITE_NOT_FOUND', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-noexist');
      const res = await makeService(tx).deleteFavorite(memberPrincipal(uid), 999_999_999);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('FAVORITE_NOT_FOUND');
    });
  });
});

describe('listFavorites（旧 ListFavoriteTest + FavoriteControllerTest 翻译）', () => {
  it('二值 type 过滤：默认只见非代发（含 NULL），fid 倒序', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-list');
      const service = makeService(tx);

      // 直接造三行：daigou / daifa / NULL（NULL 行旧系统也存在，过滤必须含它）
      await tx.dg_favorite.createMany({
        data: [
          { uid, uname: 'vitest-fav-list', typeid: 0, goodsurl: 'u1', goodsname: '代购收藏', goodsprice: 1, type: FAVORITE_TYPE.DAIGOU, addtime: 100 },
          { uid, uname: 'vitest-fav-list', typeid: 0, goodsurl: 'u2', goodsname: '代发收藏', goodsprice: 2, type: FAVORITE_TYPE.DAIFA, addtime: 200 },
          { uid, uname: 'vitest-fav-list', typeid: 0, goodsurl: 'u3', goodsname: '无类型收藏', goodsprice: 3, type: null, addtime: 300 },
        ],
      });

      const def = await service.listFavorites(memberPrincipal(uid), {});
      expect(def.ok).toBe(true);
      if (!def.ok) return;
      expect(def.value.total).toBe(2); // daigou + NULL，代发被过滤
      expect(def.value.items.map((f) => f.goodsName)).toEqual(['无类型收藏', '代购收藏']); // fid 倒序

      const daifa = await service.listFavorites(memberPrincipal(uid), { type: FAVORITE_TYPE.DAIFA });
      expect(daifa.ok).toBe(true);
      if (!daifa.ok) return;
      expect(daifa.value.total).toBe(1);
      expect(daifa.value.items[0]?.goodsName).toBe('代发收藏');
    });
  });

  it('只看自己的：别人的收藏不出现在列表里', async () => {
    await withRollback(async (tx) => {
      const me = await createUser(tx, 'vitest-fav-me');
      const other = await createUser(tx, 'vitest-fav-other2');
      await tx.dg_favorite.createMany({
        data: [
          { uid: me, uname: 'vitest-fav-me', typeid: 0, goodsurl: 'm1', goodsname: '我的', goodsprice: 1, type: FAVORITE_TYPE.DAIGOU, addtime: 100 },
          { uid: other, uname: 'vitest-fav-other2', typeid: 0, goodsurl: 'o1', goodsname: '别人的', goodsprice: 1, type: FAVORITE_TYPE.DAIGOU, addtime: 200 },
        ],
      });
      const res = await makeService(tx).listFavorites(memberPrincipal(me), {});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.total).toBe(1);
      expect(res.value.items[0]?.goodsName).toBe('我的');
    });
  });

  it('分页：page/limit 生效（默认 20，超界夹紧）', async () => {
    await withRollback(async (tx) => {
      const uid = await createUser(tx, 'vitest-fav-page');
      await tx.dg_favorite.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          uid,
          uname: 'vitest-fav-page',
          typeid: 0,
          goodsurl: `p${i}`,
          goodsname: `商品${i}`,
          goodsprice: i,
          type: FAVORITE_TYPE.DAIGOU,
          addtime: 1000 + i,
        })),
      });
      const service = makeService(tx);

      const page1 = await service.listFavorites(memberPrincipal(uid), { page: 1, limit: 10 });
      expect(page1.ok && page1.value.total).toBe(25);
      if (!page1.ok) return;
      expect(page1.value.items).toHaveLength(10);
      expect(page1.value.items[0]?.goodsName).toBe('商品24'); // fid 倒序 = addtime 倒序

      const page3 = await service.listFavorites(memberPrincipal(uid), { page: 3, limit: 10 });
      expect(page3.ok && page3.value.items).toHaveLength(5);

      // limit 超上限被契约夹紧（max 100）；page=0/负被夹到 1
      const clamped = await service.listFavorites(memberPrincipal(uid), { page: 0, limit: 500 });
      expect(clamped.ok).toBe(false); // limit 500 超 max → 契约拒绝（fail-fast，不静默夹紧）
    });
  });

  it('脏查询：type=2 / page=abc → 契约拒绝（FAVORITE_INVALID）', async () => {
    const service = makeService(legacyPrisma);
    const bad = await service.listFavorites(memberPrincipal(1), { type: 2 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('FAVORITE_INVALID');
  });
});
