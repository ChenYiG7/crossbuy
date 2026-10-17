'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crossbuy/ui';
import { FAVORITE_TYPE, type Favorite } from '@crossbuy/contract';

/**
 * 收藏区（client component）：列表 + 删除（旧 DeleteFavoriteMutation REST 化）。
 *
 * 数据由 server page 经域服务直取（BFF+RSC，不过 HTTP）传入初值；
 * 「代购 / 代发」分页签复现旧 ListFavoriteQuery 的**二值 type 过滤**
 * （不传 = 非代发含 NULL；传 3 = 只要代发）——切签与删除后重新拉取。
 *
 * 新增收藏的入口不在这里：旧 AddFavoriteMutation 的商品快照来自商品页上下文
 * （名/价/链接/图/商家），随 M2 商品页落地，见 TODO #8。
 */
type Tab = 'daigou' | 'daifa';

export function FavoritesSection({
  initialItems,
  initialTotal,
}: {
  initialItems: Favorite[];
  initialTotal: number;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('daigou');
  const [items, setItems] = useState<Favorite[]>(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [pendingFid, setPendingFid] = useState<number | null>(null);

  async function reload(next: Tab) {
    const query = next === 'daifa' ? `?type=${FAVORITE_TYPE.DAIFA}` : '';
    const res = await fetch(`/api/customer/v1/favorites${query}`);
    const json: { code: number; data: { items: Favorite[]; total: number } } = await res.json();
    if (res.ok && json.code === 0) {
      setItems(json.data.items);
      setTotal(json.data.total);
    }
  }

  async function onSwitchTab(next: Tab) {
    setTab(next);
    await reload(next);
  }

  async function onDelete(fid: number) {
    setPendingFid(fid);
    try {
      const res = await fetch(`/api/customer/v1/favorites/${fid}`, { method: 'DELETE' });
      if (res.ok) {
        await reload(tab);
        router.refresh();
      }
    } finally {
      setPendingFid(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle>我的收藏</CardTitle>
          <CardDescription>共 {total} 条（当前页签 {items.length} 条）</CardDescription>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant={tab === 'daigou' ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSwitchTab('daigou')}
          >
            代购
          </Button>
          <Button
            type="button"
            variant={tab === 'daifa' ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSwitchTab('daifa')}
          >
            代发
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有收藏商品。</p>
        ) : (
          <ul className="grid gap-2">
            {items.map((f) => (
              <li key={f.fid} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="grid gap-0.5 min-w-0">
                  <a
                    href={f.goodsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {f.goodsName}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    ¥ {f.goodsPrice} · {f.goodsSeller ?? '未知商家'} · {f.goodsSite ?? '未知平台'}
                    {f.type === FAVORITE_TYPE.DAIFA ? ' · 代发' : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingFid === f.fid}
                  onClick={() => onDelete(f.fid)}
                >
                  {pendingFid === f.fid ? '删除中…' : '删除'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
