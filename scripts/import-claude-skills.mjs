// 从 ~/.claude/skills/（Claude Code superpowers 生态）引入适配本项目的技能。
//
// 为什么需要转换而不是直接复制：上游技能写死了 superpowers 生态的跨技能引用、
// Claude Code 的 TodoWrite、以及 git worktree 工作流 —— 这些在本环境/本仓都不成立，
// 照搬会让技能指向不存在的东西。转换规则集中在本文件，改上游后重跑即可同步。
//
// 用法：node scripts/import-claude-skills.mjs [--dry]

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, basename } from 'node:path';

const DRY = process.argv.includes('--dry');
const SRC_ROOT = 'C:/Users/13621/.claude/skills';
const DST_ROOT = 'D:/Work/project/own/crossbuy/.workbuddy/skills';

// ---- 引入清单：只选与 R1 复现期纪律互补的，其余不引入（理由见函数下方注释）----
const IMPORT = [
  'verification-before-completion', // 与本项目「跑绿≠守卫有效」同宗，补 TS/门禁侧纪律
  'systematic-debugging', // 四阶段根因 —— 对应本项目踩过的「行号漂移」「造假绿」类坑
  'test-driven-development', // M0.9 Vitest 基线 + M1 翻译 219 PHPUnit 用例直接用
  'writing-plans', // M1~M5 每期计划
  'executing-plans', // 与 writing-plans 配对
  'finishing-a-development-branch', // 收口：验证→选项→执行
];
// 不引入的理由：
//  - using-superpowers   : 元技能，强制每次会话先读技能，与本环境 11 个内置技能打架
//  - writing-skills      : 本仓不造技能
//  - design-taste-frontend / impeccable : R1 复现期 UI 只 1:1 平移不重设计，
//                          且两者都自述排除 backend / dashboard；R2/R3 有需要再引
//  - ponytail            : 「最小改动 + 全会话生效的 YAGNI 模式」，与本项目性质冲突
//                          （6-7 月规模化重写，契约/防腐层/边界规则/对账都是必做项，
//                          最小改动会诱导跳过）；且其 ultra 级会反问需求，与用户
//                          「直接执行」偏好不符

// 项目侧专属内容（上游没有，且是全仓覆写的高危丢失项）。
//
// 教训（2026-10-17 首次引入实测）：本仓 .workbuddy/skills/ 里已有 3 个技能，
// 其中 test-driven-development 带一段项目裁定「生成器优先 vs TDD 只约束手写业务
// 规则」（对应 docs/07 铁律 8）。首版脚本整目录 rm + 复制，把这段**静默冲掉了**，
// 而通用适配头还在 —— 典型的「文档说有、实际没了」。
// 修法：项目专属内容集中登记在此，每次重跑按锚点重新插回；仅此一处是正本。
const PROJECT_PATCHES = {
  'test-driven-development': [
    {
      marker: '## 本项目边界（crossbuy）',
      anchorBefore: '## When to Use',
      // 逐字照抄原文（含「不套 TDD。TDD 铁律」那句不换行），否则重跑会凭空产生 diff 噪音
      body: [
        '## 本项目边界（crossbuy）',
        '',
        '本项目「生成器优先」：同构脚手架（route / CRUD / zod schema / 表单骨架）由生成器产出，不套 TDD。TDD 铁律只约束**手写的业务规则**——金额计算、状态机 cas、幂等 upsert、账本 change。',
        '',
        '- 生成器产物 → 走生成器，豁免 TDD（对应下方 "Generated code" 例外，无需再问）。',
        '- 手写业务规则 → 先写失败测试，无例外。',
      ].join('\n'),
    },
  ],
};

const ADAPT_NOTE = `
> ## crossbuy 落地适配（2026-10-17 引入时改写，由脚本生成勿手改）
>
> 本技能源自 Claude Code 的 superpowers 生态（\`~/.claude/skills/\`），引入时按本仓实况改写：
>
> - \`superpowers:*\` 前缀已剥除 —— 本仓无该生态，跨技能引用直接指向 \`.workbuddy/skills/\` 下同名技能
> - \`TodoWrite\` → 本环境的任务工具（\`TaskCreate\` / \`TaskUpdate\`）
> - **删去 \`using-git-worktrees\` 依赖与「禁止在 main 上开工」条款** —— 本仓是 main 单主干直推（用户已授权），不设 worktree
> - \`brainstorming\` 环节 → 本项目用 \`docs/04-重写架构方案.md\` + \`docs/06-开发计划.md\` 计划体系
> - 与 \`docs/07-开发规范守则.md\` 冲突时，**以 docs/07 为准**
>
> 转换规则与重跑方式见 \`scripts/import-claude-skills.mjs\`（上游更新后 \`node scripts/import-claude-skills.mjs\` 即可重新同步）
`;

// ---- 文本转换规则（顺序敏感：先整行删除，再做前缀剥除）----
const DROP_LINE_PATTERNS = [
  /^\s*-\s*\*\*superpowers:using-git-worktrees\*\*.*$/m,
  // 注意列表项可能带 "- " 前缀 —— 漏配会导致适配头声明「已删」而正文还在（文档造假）
  /^\s*(?:-\s*)?Never start implementation on main\/master branch without explicit user consent\s*$/m,
];

const REWRITES = [
  [/superpowers:([a-z-]+)/g, '$1'],
  [/\bTodoWrite\b/g, 'TaskCreate'],
  [/superpowers:/g, ''], // 兜底：形如 "Use superpowers:xxx to ..." 的残留在上一规则后仍可能有冒号
];

function convertSkillMd(src) {
  let out = src;

  for (const p of DROP_LINE_PATTERNS) out = out.replace(p, '');
  for (const [re, rep] of REWRITES) out = out.replace(re, rep);

  // 插到 frontmatter 之后（第二个 --- 之后）
  const lines = out.split('\n');
  let fence = 0;
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      fence++;
      if (fence === 2) {
        insertAt = i + 1;
        break;
      }
    }
  }
  if (insertAt === -1) throw new Error('frontmatter 未闭合，无法插入适配说明');
  lines.splice(insertAt, 0, ADAPT_NOTE);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// 把项目专属内容按锚点插回（幂等：marker 已存在则跳过）
function applyProjectPatches(text, skillName) {
  const patches = PROJECT_PATCHES[skillName];
  if (!patches || patches.length === 0) return { text, applied: 0, missingAnchor: [] };

  let out = text;
  let applied = 0;
  const missingAnchor = [];

  for (const p of patches) {
    if (out.includes(p.marker)) continue; // 已存在，不重复插
    const idx = out.indexOf(p.anchorBefore);
    if (idx === -1) {
      missingAnchor.push(p.anchorBefore);
      continue;
    }
    out = out.slice(0, idx) + p.body + '\n\n' + out.slice(idx);
    applied++;
  }

  return { text: out, applied, missingAnchor };
}

// 覆写前嗅探目标侧的本地内容，避免再次静默冲掉项目专属改动
function sniffLocalContent(dstPath) {
  if (!existsSync(dstPath)) return [];
  return readFileSync(dstPath, 'utf8')
    .split('\n')
    .filter((l) => /crossbuy|本项目/.test(l) && !/landing|适配（/.test(l));
}

function main() {
  if (!existsSync(SRC_ROOT)) throw new Error(`上游不存在：${SRC_ROOT}`);
  if (!DRY) mkdirSync(DST_ROOT, { recursive: true });

  const report = [];
  for (const name of IMPORT) {
    const srcDir = join(SRC_ROOT, name);
    const dstDir = join(DST_ROOT, name);
    if (!existsSync(join(srcDir, 'SKILL.md'))) {
      report.push(`SKIP  ${name}（上游无 SKILL.md）`);
      continue;
    }

    if (!DRY) {
      rmSync(dstDir, { recursive: true, force: true });
      mkdirSync(dstDir, { recursive: true });
    }

    // 附属文件（参考文档/脚本）一并带入，但排除上游的开发日志
    const files = readdirSync(srcDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((f) => !/^CREATION-LOG\.md$/i.test(f));

    // 覆写前先取证：目标侧若有项目专属内容，报告出来（不能被静默冲掉）
    const localLines = sniffLocalContent(join(dstDir, 'SKILL.md'));

    if (!DRY) {
      rmSync(dstDir, { recursive: true, force: true });
      mkdirSync(dstDir, { recursive: true });
    }

    let converted = false;
    let patched = 0;
    let missingAnchor = [];
    for (const f of files) {
      const srcPath = join(srcDir, f);
      const dstPath = join(dstDir, f);
      if (f === 'SKILL.md') {
        const convertedText = convertSkillMd(readFileSync(srcPath, 'utf8'));
        const patchedResult = applyProjectPatches(convertedText, name);
        patched = patchedResult.applied;
        missingAnchor = patchedResult.missingAnchor;
        if (!DRY) writeFileSync(dstPath, patchedResult.text, 'utf8');
        converted = true;
      } else if (!DRY) {
        cpSync(srcPath, dstPath);
      }
    }

    let line = `OK    ${name}  (${files.length} 文件, 转换=${converted}, 项目补丁=${patched})`;
    if (localLines.length > 0) {
      line += `\n      覆写前目标侧含 ${localLines.length} 行项目专属内容（已由 PATCH 机制兜底）：`;
      for (const l of localLines.slice(0, 4)) line += `\n        | ${l.trim().slice(0, 90)}`;
    }
    if (missingAnchor.length > 0) {
      line += `\n      WARN 锚点缺失，补丁未插入：${missingAnchor.join(', ')}`;
    }
    report.push(line);
  }

  console.log(`[import] 源 ${SRC_ROOT}\n[import] 目标 ${DST_ROOT}\n`);
  console.log(report.join('\n'));
  console.log(`\n[import] 共 ${IMPORT.length} 个技能${DRY ? '（dry-run，未落盘）' : '已写入'}`);
}

main();
