import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '淘太郎 · 运营后台',
  description: '运营管理后台（替代旧 dcat-admin）',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
