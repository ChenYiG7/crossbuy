/**
 * 设计 token：三端（web/mzk/admin）共用的主题变量，映射到 CSS variables。
 * 正式接入 Tailwind/shadcn 后，这些 token 与 globals.css 里的 CSS 变量一一对应。
 */
export const colorTokens = {
  brand: 'hsl(var(--brand))',
  brandForeground: 'hsl(var(--brand-foreground))',
  background: 'hsl(var(--background))',
  foreground: 'hsl(var(--foreground))',
  muted: 'hsl(var(--muted))',
  mutedForeground: 'hsl(var(--muted-foreground))',
  card: 'hsl(var(--card))',
  cardForeground: 'hsl(var(--card-foreground))',
  border: 'hsl(var(--border))',
  destructive: 'hsl(var(--destructive))',
} as const;

export const radiusTokens = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  lg: 'var(--radius-lg)',
} as const;
