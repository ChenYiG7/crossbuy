import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@crossbuy/ui';
import { LocaleSwitcher } from './locale-switcher';

export default async function Home() {
  const t = await getTranslations('home');
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">淘太郎 · {t('前台（web）')}</h1>
          <Badge>shared UI</Badge>
        </div>
        <LocaleSwitcher />
      </header>
      <p className="text-sm text-muted-foreground">
        {t(
          '面向日本市场的中国商品代购平台。以下卡片由 packages/ui 共享组件渲染（Tailwind 4 + shadcn/ui），member 域首屏接入后替换本演示。',
        )}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>{t('搜索商品')}</CardTitle>
          <CardDescription>{t('输入关键词或商品 URL（演示表单）。')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="keyword">{t('关键词')}</Label>
          <Input id="keyword" placeholder={t('例：小番茄')} />
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button>{t('搜索')}</Button>
          <Button variant="secondary">{t('从 URL 导入')}</Button>
          <Button variant="ghost">{t('清空')}</Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('会员中心（M1 垂直切片）')}</CardTitle>
          <CardDescription>
            {t('登录（旧 LoginMutation 规则复现）→ 查看资料与余额（旧 getUserInfo 的 REST 化）。')}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild variant="outline">
            <Link href="/member">{t('前往会员中心')}</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
