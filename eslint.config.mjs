import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 域清单——与 scripts/scaffold-domains.mjs 的 DOMAINS 保持一致（改域清单时两处同改）。
 * 边界规则靠工具不靠自觉（docs/04 §3.2-6）：守卫有效性由 scripts/boundary-probe.mjs
 * 用故意违规样例破坏验证，不是看出来的。
 */
const DOMAINS = [
  'member',
  'order',
  'purchase',
  'send-order',
  'logistics',
  'platform',
  'finance',
  'ticket',
  'content',
  'openapi',
  'wms-gateway',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
      '**/packages/db/generated/**',
      '**/packages/db/src/generated/**', // Prisma client 生成产物（legacy + redesign），非手写代码
      // 注意：禁在此忽略 __probe_*.ts——边界探针必须被 lint 到，否则破坏验证失效
      //（提交安全由 .gitignore 的 **/__probe_*.ts 负责）
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // ---- 边界规则 1（全局）：@crossbuy/db 仅 domains/*/repository 防腐层可 import ----
  // 覆盖 apps/*、packages/*（domains 的 repository 例外在下面按域配置里再声明）
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['packages/domains/*/src/repository.ts', 'packages/db/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@crossbuy/db',
              message:
                'DB 仅允许 packages/domains/*/src/repository.ts 防腐层 import（docs/04 §5）；app/其他包要用数据走域 service 接口',
            },
          ],
        },
      ],
    },
  },
  // ---- 边界规则 2（按域）：DB 禁令 + 域间禁横向 import ----
  // 每个域一条配置（no-restricted-imports 同 rule id 后者覆盖前者，故两类禁令合并写）
  ...DOMAINS.map((domain) => ({
    files: [`packages/domains/${domain}/**/*.ts`],
    ignores: [`packages/domains/${domain}/src/repository.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@crossbuy/db',
              message: `${domain} 域仅 repository.ts 可 import @crossbuy/db（docs/04 §5）`,
            },
          ],
          patterns: DOMAINS.filter((other) => other !== domain).map((other) => ({
            group: [`@crossbuy/domain-${other}`, `@crossbuy/domain-${other}/**`],
            message: `域间禁横向 import：${domain} → ${other}；跨域调用走属主域 service 接口，跨域反应走 contract 事件（docs/04 §3.2-2）`,
          })),
        },
      ],
    },
  })),
  // ---- 边界规则 3：contract 唯一外部依赖 = zod（docs/07 铁律 6 / docs/04 §3.2-3）----
  {
    files: ['packages/contract/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@crossbuy/db',
                '@crossbuy/db/**',
                '@crossbuy/domain-*',
                '@crossbuy/domain-*/**',
                '@crossbuy/auth',
                '@crossbuy/auth/**',
                '@crossbuy/utils',
                '@crossbuy/utils/**',
                '@crossbuy/ui',
                '@crossbuy/ui/**',
                '@crossbuy/notify',
                '@crossbuy/notify/**',
                '@prisma/client',
                'prisma',
                'prisma/**',
                'next',
                'next/**',
                'react',
                'react/**',
                'fastify',
                'fastify/**',
              ],
              message:
                'contract 包唯一允许的外部依赖是 zod——禁 ORM/框架/其他包类型（docs/07 铁律 6）',
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // ---- React / Next 规则（#6-b：2026-10-18 接入）----
  // react-hooks：所有 React 代码位点（三个 Next app + packages/ui 共享组件源）
  // ★ 用 recommended-latest（flat 原生 plugins 对象）；recommended 是 eslintrc 数组形态，flat 会报错
  {
    files: ['apps/**/*.{ts,tsx,js,jsx}', 'packages/ui/**/*.{ts,tsx,js,jsx}'],
    ...reactHooks.configs['recommended-latest'],
  },
  // next core-web-vitals：仅 Next app（packages/ui 无 next 运行时；api/worker 是 Node）
  {
    files: ['apps/*/**/*.{ts,tsx,js,jsx}'],
    ...nextPlugin.flatConfig.coreWebVitals,
  },
);
