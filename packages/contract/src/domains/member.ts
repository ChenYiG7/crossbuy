import { z } from 'zod';

/**
 * member 域契约 —— 迁移阶段 1 的试水域（旧系统文档最全、边界最清、对外接口稳定）。
 * 每个域一个文件，入口统一在 src/index.ts 收口。
 */

export const memberCreateSchema = z.object({
  email: z.string().email(),
  nickname: z.string().max(64).optional(),
  /** 是否代发用户（dfFlag） */
  isDf: z.boolean().default(false),
});
export type MemberCreate = z.infer<typeof memberCreateSchema>;

export const memberUpdateSchema = memberCreateSchema.partial();
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

/** 行视图：HTTP 边界出参，日期序列化为 ISO 字符串，敏感字段（凭证/明文地址）一律不出契约 */
export const memberRowSchema = z.object({
  id: z.number().int().positive(),
  email: z.string().email(),
  nickname: z.string().nullable(),
  isDf: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;
