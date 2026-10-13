import { colorTokens } from '@crossbuy/ui';

export default function Home() {
  return (
    <main style={{ padding: 32 }}>
      <h1 style={{ color: colorTokens.brand }}>淘太郎 · 运营后台（admin）</h1>
      <p>运营管理后台骨架（替代 dcat-admin），待接入 RBAC 与首屏。</p>
    </main>
  );
}
