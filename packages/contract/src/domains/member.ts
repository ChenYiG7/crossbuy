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

// ---------------------------------------------------------------------------
// 会员资料编辑（R1 复现期：对齐旧系统 EditUserInfo mutation）
//
// 词表正本 = 旧系统 `App\Models\User`（haiou，只读参考）：
//   regType（列 regtype）              : 0=个人 1=公司
//   sex（列 sex）                      : 0=女性 1=男性
//   useType（列 usetype）              : 1=代理購入 2=転送 3=無在庫 4=OEM 5=1688转运
//   originPackageChoice（列 origin_package_choice）: 0=废弃原包装（默认） 1=保留原包装
//
// ⚠ 这四个列在库里都是 tinyint(1)，但 usetype 实际存 1..5 —— 不是布尔。
//   见 docs/plans/07 §三「★ tinyint(1) → Boolean 陷阱」：Prisma 已统一降级为 Int。
// ---------------------------------------------------------------------------

export const REG_TYPE = { PERSONAL: 0, COMPANY: 1 } as const;
export const GENDER = { FEMALE: 0, MALE: 1 } as const;
export const USE_TYPE = {
  AGENCY_PURCHASE: 1, // 代理購入
  FORWARD: 2, // 転送
  NO_STOCK: 3, // 無在庫
  OEM: 4,
  TRANSFER_1688: 5, // 1688转运
} as const;
export const ORIGIN_PACKAGE_CHOICE = { DISCARD: 0, KEEP: 1 } as const;

export const useTypeSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type UseType = z.infer<typeof useTypeSchema>;

/** 资料编辑入参：全部可选（旧 mutation 允许只传一个字段） */
export const memberProfileUpdateSchema = z.object({
  regType: z.union([z.literal(0), z.literal(1)]).optional(),
  companyName: z.string().max(255).optional(),
  trueName: z.string().max(255).optional(),
  sex: z.union([z.literal(0), z.literal(1)]).optional(),
  tel: z.string().max(64).optional(),
  address: z.string().max(255).optional(),
  zip: z.string().max(32).optional(),
  country: z.string().max(64).optional(),
  qq: z.string().max(64).optional(),
  useType: useTypeSchema.optional(),
  avatar: z.string().url().optional(),
  originPackageChoice: z.union([z.literal(0), z.literal(1)]).optional(),
});
export type MemberProfileUpdate = z.infer<typeof memberProfileUpdateSchema>;

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
