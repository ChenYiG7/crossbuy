/**
 * 设计 token：三端（web/mzk/admin）共用的主题变量，映射到 CSS variables。
 *
 * ⚠ 正本是 src/styles/theme.css 的 :root/.dark —— 本文件只是 TS 镜像，
 * 供 canvas/图表库等拿不到 class 的场景取值（hsl 三元组 + 可选 `/ alpha`）。
 * **改 theme.css 必须同步改这里**；新增 token 先加 theme.css 再加这里。
 */
export const colorTokens = {
  brand: 'hsl(var(--brand))',
  brandForeground: 'hsl(var(--brand-foreground))',
  primary: 'hsl(var(--primary))',
  primaryForeground: 'hsl(var(--primary-foreground))',
  secondary: 'hsl(var(--secondary))',
  secondaryForeground: 'hsl(var(--secondary-foreground))',
  accent: 'hsl(var(--accent))',
  accentForeground: 'hsl(var(--accent-foreground))',
  destructive: 'hsl(var(--destructive))',
  destructiveForeground: 'hsl(var(--destructive-foreground))',
  background: 'hsl(var(--background))',
  foreground: 'hsl(var(--foreground))',
  card: 'hsl(var(--card))',
  cardForeground: 'hsl(var(--card-foreground))',
  popover: 'hsl(var(--popover))',
  popoverForeground: 'hsl(var(--popover-foreground))',
  muted: 'hsl(var(--muted))',
  mutedForeground: 'hsl(var(--muted-foreground))',
  border: 'hsl(var(--border))',
  input: 'hsl(var(--input))',
  ring: 'hsl(var(--ring))',
} as const;

/** 图表通用序列；涨跌配色按 A 股惯例（涨红跌绿）在图表处显式指定，不用这里隐含 */
export const chartTokens = {
  chart1: 'hsl(var(--chart-1))',
  chart2: 'hsl(var(--chart-2))',
  chart3: 'hsl(var(--chart-3))',
  chart4: 'hsl(var(--chart-4))',
  chart5: 'hsl(var(--chart-5))',
} as const;

/** admin 侧边栏（对齐旧 dcat-admin 暗色观感） */
export const sidebarTokens = {
  sidebar: 'hsl(var(--sidebar))',
  sidebarForeground: 'hsl(var(--sidebar-foreground))',
  sidebarPrimary: 'hsl(var(--sidebar-primary))',
  sidebarPrimaryForeground: 'hsl(var(--sidebar-primary-foreground))',
  sidebarAccent: 'hsl(var(--sidebar-accent))',
  sidebarAccentForeground: 'hsl(var(--sidebar-accent-foreground))',
  sidebarBorder: 'hsl(var(--sidebar-border))',
  sidebarRing: 'hsl(var(--sidebar-ring))',
} as const;

export const radiusTokens = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
  xl: 'var(--radius-xl)',
} as const;
