import { PrismaClient as LegacyPrismaClient } from './generated/legacy';
import { PrismaClient as RedesignPrismaClient } from './generated/redesign';

/**
 * Prisma 客户端单例（双 schema 双 client，2026-10-16 M0.1，docs/04 §2）：
 *
 * - `legacyPrisma`  → prisma/schema.prisma（R1 活跃 = 旧库 introspect）。
 *   域代码只允许经 packages/domains 下各域 repository 防腐层使用它；
 *   直接 import 本文件属于架构违规（ESLint 边界规则会拦）。
 * - `redesignPrisma` → prisma/redesign/schema.prisma（R2 封存资产，60 模型新表）。
 *   R1 期间不接业务流量，仅保鲜（db:generate + typecheck）；R2 启动时启用。
 *
 * 两个 client 输出目录物理隔离（src/generated/{legacy,redesign}），防串用。
 * 过渡期与旧系统共用同一 MySQL；legacy client 绝不对旧表做破坏性结构变更。
 */
const globalForPrisma = globalThis as unknown as {
  legacyPrisma?: LegacyPrismaClient;
  redesignPrisma?: RedesignPrismaClient;
};

export const legacyPrisma =
  globalForPrisma.legacyPrisma ?? new LegacyPrismaClient();

export const redesignPrisma =
  globalForPrisma.redesignPrisma ?? new RedesignPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.legacyPrisma = legacyPrisma;
  globalForPrisma.redesignPrisma = redesignPrisma;
}
