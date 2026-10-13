import { PrismaClient } from '@prisma/client';

/**
 * Prisma 客户端单例：开发热重载下避免重复建连接。
 * 过渡期与旧系统共用同一 MySQL，本客户端只做「读分析/新系统读写」，
 * 绝不对旧系统表结构做破坏性变更。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
