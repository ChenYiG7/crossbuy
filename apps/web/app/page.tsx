import Link from 'next/link';
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

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">淘太郎 · 前台（web）</h1>
        <Badge>shared UI</Badge>
      </header>
      <p className="text-sm text-muted-foreground">
        面向日本市场的中国商品代购平台。以下卡片由 packages/ui 共享组件渲染（Tailwind 4 +
        shadcn/ui），member 域首屏接入后替换本演示。
      </p>
      <Card>
        <CardHeader>
          <CardTitle>商品を検索</CardTitle>
          <CardDescription>
            キーワードまたは商品 URL を入力してください（デモフォーム）。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Label htmlFor="keyword">キーワード</Label>
          <Input id="keyword" placeholder="例：ミニトマト" />
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          <Button>検索</Button>
          <Button variant="secondary">URL から取込</Button>
          <Button variant="ghost">クリア</Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>会员中心（M1 垂直切片）</CardTitle>
          <CardDescription>
            登录（旧 LoginMutation 规则复现）→ 查看资料与余额（旧 getUserInfo 的 REST 化）。
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild variant="outline">
            <Link href="/member">前往会员中心</Link>
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
