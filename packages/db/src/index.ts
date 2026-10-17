export { legacyPrisma, redesignPrisma } from './client';
export type { PrismaClient as LegacyPrismaClient } from './generated/legacy';
export type { Prisma as LegacyPrisma } from './generated/legacy';
/** 运行时命名空间（Prisma.join/Decimal 等 raw 查询工具；禁把 client 实例从这里绕出去） */
export { Prisma as LegacyPrismaRuntime } from './generated/legacy';
export type { PrismaClient as RedesignPrismaClient } from './generated/redesign';
export type { Prisma as RedesignPrisma } from './generated/redesign';
