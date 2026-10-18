#!/usr/bin/env node
/**
 * boundary-probe.mjs —— ESLint 边界规则破坏验证（docs/06 §2.2 / docs/04 §3.2-6：
 * 「M0 用故意违规样例验证 CI 真会拦——守卫有效性是破坏出来的，不是看出来的」）。
 *
 * 在真实受限位置生成探针文件，跑 eslint 断言行为，finally 删除：
 *   P1 domains/member 非 repository 文件 import @crossbuy/db   → 必须拦（per-domain 规则）
 *   P2 domains/order import @crossbuy/domain-member            → 必须拦（域间禁横向）
 *   P3 packages/contract import @crossbuy/db                   → 必须拦（contract 纯净）
 *   P4 apps/web import @crossbuy/db                            → 必须拦（全局规则）
 *   P5 对照：domains/member/src/repository.ts（合法）           → 必须干净（证明不是一刀切误杀）
 *
 * 退出码：任一断言不符即 1（可挂 CI）。
 */
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESLINT_ENTRY = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

const PROBES = [
  {
    id: 'P1',
    desc: 'member 非 repository 文件 import @crossbuy/db',
    file: 'packages/domains/member/src/__probe_db.ts',
    content: "import { legacyPrisma } from '@crossbuy/db';\nexport const probe = legacyPrisma;\n",
    expect: 'blocked',
  },
  {
    id: 'P2',
    desc: 'order 域 import member 域（横向依赖）',
    file: 'packages/domains/order/src/__probe_cross.ts',
    content:
      "import type { MemberService } from '@crossbuy/domain-member';\nexport type Probe = MemberService;\n",
    expect: 'blocked',
  },
  {
    id: 'P3',
    desc: 'contract import @crossbuy/db（纯净性）',
    file: 'packages/contract/src/__probe_orm.ts',
    content: "import { legacyPrisma } from '@crossbuy/db';\nexport const probe = legacyPrisma;\n",
    expect: 'blocked',
  },
  {
    id: 'P4',
    desc: 'app 层 import @crossbuy/db（全局规则）',
    file: 'apps/web/__probe_db.ts',
    content: "import { legacyPrisma } from '@crossbuy/db';\nexport const probe = legacyPrisma;\n",
    expect: 'blocked',
  },
  {
    id: 'P5',
    desc: '对照：member/src/repository.ts 合法 import @crossbuy/db',
    file: 'packages/domains/member/src/repository.ts',
    content: null, // 已存在的合法文件，不生成
    expect: 'clean',
  },
];

const runEslint = (relPath) =>
  spawnSync(process.execPath, [ESLINT_ENTRY, relPath], {
    cwd: ROOT,
    encoding: 'utf8',
  });

let failures = 0;

try {
  for (const probe of PROBES) {
    if (probe.content !== null) {
      const abs = path.join(ROOT, probe.file);
      writeFileSync(abs, probe.content);
      if (!existsSync(abs)) throw new Error(`探针写入失败：${probe.file}`);
    }

    const { status, stdout = '', stderr = '' } = runEslint(probe.file);
    const output = stdout + stderr;
    const blockedByBoundaryRule = status !== 0 && output.includes('no-restricted-imports');

    let verdict;
    if (probe.expect === 'blocked') {
      verdict = blockedByBoundaryRule ? 'PASS（被拦）' : `FAIL（未被拦，status=${status}）`;
    } else {
      // 对照项：必须完全干净。注意区分「误杀」与「探针自身语法错误」
      verdict = status === 0 ? 'PASS（干净）' : `FAIL（被误杀或自身报错，status=${status}）`;
    }
    if (verdict.startsWith('FAIL')) failures += 1;
    console.log(`${probe.id} ${verdict} — ${probe.desc}`);
    if (verdict.startsWith('FAIL')) {
      console.log('  --- eslint 输出（截断）---');
      console.log(
        output
          .split('\n')
          .filter((l) => l.includes('error') || l.includes('no-restricted'))
          .slice(0, 5)
          .map((l) => `  ${l}`)
          .join('\n'),
      );
    }
  }
} finally {
  // 清理探针（P5 是合法文件，不动）
  for (const probe of PROBES) {
    if (probe.content !== null) rmSync(path.join(ROOT, probe.file), { force: true });
  }
}

console.log(
  failures === 0
    ? '\n边界守卫全部按预期工作（5/5）。'
    : `\n${failures} 个断言失败——守卫不可信，先修 eslint.config.mjs 再谈 CI。`,
);
process.exit(failures === 0 ? 0 : 1);
