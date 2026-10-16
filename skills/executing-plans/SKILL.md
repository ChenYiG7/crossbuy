---
name: executing-plans
description: Use when you have a written implementation plan to execute in a separate session with review checkpoints
---

> ## crossbuy 落地适配（2026-10-17 引入时改写，由脚本生成勿手改）
>
> 本技能源自 Claude Code 的 superpowers 生态（`~/.claude/skills/`），引入时按本仓实况改写：
>
> - `superpowers:*` 前缀已剥除 —— 本仓无该生态，跨技能引用直接指向 `.workbuddy/skills/` 下同名技能
> - `TodoWrite` → 本环境的任务工具（`TaskCreate` / `TaskUpdate`）
> - **删去 `using-git-worktrees` 依赖与「禁止在 main 上开工」条款** —— 本仓是 main 单主干直推（用户已授权），不设 worktree
> - `brainstorming` 环节 → 本项目用 `docs/04-重写架构方案.md` + `docs/06-开发计划.md` 计划体系
> - 与 `docs/07-开发规范守则.md` 冲突时，**以 docs/07 为准**
>
> 转换规则与重跑方式见 `scripts/import-claude-skills.mjs`（上游更新后 `node scripts/import-claude-skills.mjs` 即可重新同步）

# Executing Plans

## Overview

Load plan, review critically, execute all tasks, report when complete.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

**Note:** Tell your human partner that Superpowers works much better with access to subagents. The quality of its work will be significantly higher if run on a platform with subagent support (such as Claude Code or Codex). If subagents are available, use subagent-driven-development instead of this skill.

## The Process

### Step 1: Load and Review Plan
1. Read plan file
2. Review critically - identify any questions or concerns about the plan
3. If concerns: Raise them with your human partner before starting
4. If no concerns: Create TaskCreate and proceed

### Step 2: Execute Tasks

For each task:
1. Mark as in_progress
2. Follow each step exactly (plan has bite-sized steps)
3. Run verifications as specified
4. Mark as completed

### Step 3: Complete Development

After all tasks complete and verified:
- Announce: "I'm using the finishing-a-development-branch skill to complete this work."
- **REQUIRED SUB-SKILL:** Use finishing-a-development-branch
- Follow that skill to verify tests, present options, execute choice

## When to Stop and Ask for Help

**STOP executing immediately when:**
- Hit a blocker (missing dependency, test fails, instruction unclear)
- Plan has critical gaps preventing starting
- You don't understand an instruction
- Verification fails repeatedly

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**
- Partner updates the plan based on your feedback
- Fundamental approach needs rethinking

**Don't force through blockers** - stop and ask.

## Remember
- Review plan critically first
- Follow plan steps exactly
- Don't skip verifications
- Reference skills when plan says to
- Stop when blocked, don't guess

## Integration

**Required workflow skills:**

- **writing-plans** - Creates the plan this skill executes
- **finishing-a-development-branch** - Complete development after all tasks
