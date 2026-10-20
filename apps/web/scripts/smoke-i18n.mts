/**
 * apps/web i18n 端到端冒烟——防「next-intl 接线被误删/破坏」的回归闸。
 *
 * 与 smoke-member 的分工：那边证明登录链路通（带 scratch 库）；
 * 本脚本只验证 **语言切换链路**：cookie → getRequestConfig → 词典 → RSC 渲染
 * （lang 属性 + 文案），以及非法 locale 回落。首页不碰 DB ⇒ 无需 scratch 库。
 *
 * 断言口径：
 *   ① 无 cookie        → lang="ja" + 默认日文文案（对客缺省）
 *   ② NEXT_LOCALE=en   → lang="en" + 英文文案
 *   ③ NEXT_LOCALE=zh   → lang="zh" + 中文（zh 空词典回退 key 本身）
 *   ④ NEXT_LOCALE=fr   → 非法值回落 ja（isLocale 守卫）
 *
 * errCode 出域断言（需要 DB）归 smoke-member 的登录链路，不在此重复。
 *
 * 前置：`pnpm build`（next start 需要生产构建）。
 * 用法：pnpm --filter @crossbuy/web smoke:i18n
 */
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
  }
}

function startServer(): ChildProcess {
  return spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    cwd: process.cwd(),
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // 首页不连 DB，但 env 校验要求合法格式——给一个不可达库名即可
      DATABASE_URL: 'mysql://root:root@127.0.0.1:3306/unused_by_i18n_smoke',
      AUTH_SESSION_SECRET: 'e2e-i18n-smoke-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady(child: ChildProcess, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return true;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function getHome(cookie?: string): Promise<{ html: string; lang: string | null }> {
  const res = await fetch(`${BASE}/`, {
    headers: cookie ? { cookie } : {},
  });
  const html = await res.text();
  const lang = /<html[^>]*\slang="([^"]*)"/.exec(html)?.[1] ?? null;
  return { html, lang };
}

async function main(): Promise<void> {
  console.log('[0] 启动 next start（无 DB）并等待就绪');
  const child = startServer();
  const serverLog: string[] = [];
  child.stdout?.on('data', (d: Buffer) => serverLog.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => serverLog.push(d.toString()));

  try {
    const ready = await waitReady(child);
    check('服务就绪（GET / 返回 200）', ready);
    if (!ready) {
      console.log(serverLog.join('').slice(-2000));
      return;
    }

    console.log('[1] 默认语言（无 cookie）→ ja');
    const def = await getHome();
    check('无 cookie → lang="ja"', def.lang === 'ja', def.lang);
    check('无 cookie → 含默认日文文案「商品を検索」', def.html.includes('商品を検索'));

    console.log('[2] NEXT_LOCALE=en → 英文');
    const en = await getHome('NEXT_LOCALE=en');
    check('en cookie → lang="en"', en.lang === 'en', en.lang);
    check('en cookie → 含英文文案「Search products」', en.html.includes('Search products'));

    console.log('[3] NEXT_LOCALE=zh → 中文（空词典回退 key）');
    const zh = await getHome('NEXT_LOCALE=zh');
    check('zh cookie → lang="zh"', zh.lang === 'zh', zh.lang);
    check('zh cookie → 含中文文案「搜索商品」', zh.html.includes('搜索商品'));

    console.log('[4] 非法 locale 回落 ja');
    const bad = await getHome('NEXT_LOCALE=fr');
    check('fr cookie → 回落 lang="ja"', bad.lang === 'ja', bad.lang);
    check('fr cookie → 含日文文案（回落生效）', bad.html.includes('商品を検索'));
  } finally {
    child.kill();
  }

  console.log(failures === 0 ? '\ni18n smoke 全绿' : `\n${failures} 条断言失败`);
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
