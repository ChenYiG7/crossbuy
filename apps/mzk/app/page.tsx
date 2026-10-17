import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@crossbuy/ui';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">淘太郎 · 代发端（mzk）</h1>
        <Badge variant="secondary">shared UI</Badge>
      </header>
      <p className="text-sm text-muted-foreground">
        代发用户工作台骨架（dfFlag 用户 302 到此）。以下为共享组件演示，代发业务接入后替换。
      </p>
      <Card>
        <CardHeader>
          <CardTitle>本日の代行発注</CardTitle>
          <CardDescription>仕入先から取得後に自動更新されます（デモ）。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="grid gap-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Separator />
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="grid gap-1">
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        </CardContent>
      </Card>
      <div className="flex gap-2">
        <Button size="sm">更新</Button>
        <Button size="sm" variant="outline">
          履歴
        </Button>
      </div>
    </main>
  );
}
