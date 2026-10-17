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
        <h1 className="text-2xl font-semibold tracking-tight">淘太郎 · 运营后台（admin）</h1>
        <Badge>shared UI</Badge>
      </header>
      <p className="text-sm text-muted-foreground">
        运营管理后台骨架（替代 dcat-admin）。以下为共享组件演示，RBAC 与首屏接入后替换。
      </p>
      <Card>
        <CardHeader>
          <CardTitle>组件基线</CardTitle>
          <CardDescription>
            packages/ui 为三端唯一组件源（Tailwind 4 + shadcn/ui，new-york 风格）。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>default</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="destructive">destructive</Badge>
            <Badge variant="outline">outline</Badge>
          </div>
          <Separator />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">主要操作</Button>
            <Button size="sm" variant="secondary">
              次要
            </Button>
            <Button size="sm" variant="outline">
              描边
            </Button>
            <Button size="sm" variant="ghost">
              幽灵
            </Button>
            <Button size="sm" variant="destructive">
              危险
            </Button>
            <Button size="sm" variant="link">
              链接
            </Button>
          </div>
          <Separator />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    </main>
  );
}
