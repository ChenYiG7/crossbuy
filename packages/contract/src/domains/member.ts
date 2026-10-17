import { z } from 'zod';
import type { Money } from '../core';

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

// ---------------------------------------------------------------------------
// 登录（R1 复现旧 LoginMutation 业务规则；旧 GraphQL 入参 from/captcha 属传输层，
// REST 面不继承——验证码复现在 TODO 登记，见 docs/plans/08）
//
// 规则正本 = 旧 `App\GraphQL\Mutations\Member\LoginMutation` + `User::checkUserLoginLimit()`：
//   1. 限流：同一 username 5 次/分钟（旧 RateLimiter，端口化后 Redis 实现随基建落地）
//   2. username 是合法邮箱 → 匹配 email 列，否则匹配 uname 列（旧 filter_var 语义）
//   3. password 走 MD5 无盐比对（旧库 password CHAR(32)）；argon2id 透明升级随 R2 新表，
//      R1「数据库不动」存不下 ~97 字符哈希——见 docs/plans/08
//   4. state 三闸：0=未審査 / -1=审核失败 / 3=使用禁止 → 分别拒绝
//   5. checkUserLoginLimit：state=4 直接拒；orderenable=0 且 stoptime 早于 7 天前 →
//      **先把用户改成 state=4/orderenable=0 再拒**（旧代码检查即改库，1:1 复现并登记 R2）
//   6. 成功 → logintime 落当前 unix 时间戳（Asia/Shanghai 语义）
// ---------------------------------------------------------------------------

/** 客户状态词表（旧 App\Models\User::$userState，1:1 复现） */
export const MEMBER_STATE = {
  REVIEW_FAILED: -1, // 审核失败
  PENDING_REVIEW: 0, // 未審査
  NORMAL: 1, // 正常
  NORMAL_2: 2, // 正常2
  FORBIDDEN: 3, // 使用禁止
  LOGIN_RESTRICTED: 4, // 登录限制
} as const;
export type MemberState = (typeof MEMBER_STATE)[keyof typeof MEMBER_STATE];

/** 登录入参（REST 面） */
export const memberLoginSchema = z.object({
  /** 账号：邮箱或 uname（旧系统两种皆可登录） */
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(128),
  rememberMe: z.boolean().default(false),
});
export type MemberLogin = z.infer<typeof memberLoginSchema>;

// ---------------------------------------------------------------------------
// 会员资料读模型（旧 getUserInfo 的 dg_users 核心字段，1:1 映射）。
//
// 列映射（旧 GraphQL alias → 旧列，禁顺手改名）：
//   companyCode → compost（公司邮编，不是统一社会信用代码）
//   preBuyFrequency → prebuyfeq / preBuyAmount → prebuyamt
//   useType → usetype（1..5 枚举，tinyint(1) 但不是布尔）
//   avatar → face；dfFlag → dfflag（0/1 → boolean）
//   useInquiry → reg_extra JSON 里的 useInquiry 键（旧系统 json_encode 存储）
//   money → Decimal(10,2)，契约里是字符串（禁浮点；服务端 utils/money 单入口序列化）
//
// 旧 getUserInfo 的跨域字段（unreadInstantChat / unreadGuestBook / emailSubscribeStatus /
// businessManager）随属主域落地补齐——别域数据禁直连表（docs/04 §3.2-1）。
// ---------------------------------------------------------------------------

/** 会员资料读模型（"我"的出参） */
export const memberProfileSchema = z.object({
  uid: z.number().int().positive(),
  uname: z.string(),
  email: z.string().nullable(),
  regType: z.number().int().nullable(),
  companyName: z.string().nullable(),
  companyNameEng: z.string().nullable(),
  companyManager: z.string().nullable(),
  companyManagerEng: z.string().nullable(),
  companyCode: z.string().nullable(),
  companyTel: z.string().nullable(),
  companyAddress: z.string().nullable(),
  companyAddressEng: z.string().nullable(),
  trueName: z.string().nullable(),
  sex: z.number().int().nullable(),
  zip: z.string().nullable(),
  tel: z.string().nullable(),
  address: z.string().nullable(),
  country: z.string().nullable(),
  qq: z.string().nullable(),
  line: z.string().nullable(),
  wechat: z.string().nullable(),
  useType: z.number().int().nullable(),
  preBuyFrequency: z.string().nullable(),
  preBuyAmount: z.string().nullable(),
  /** 余额：字符串承载（Decimal 序列化，禁 JS 浮点） */
  money: z.string(),
  dfFlag: z.boolean(),
  avatar: z.string().nullable(),
  /** 是否使用询价（reg_extra JSON） */
  useInquiry: z.boolean(),
  originPackageChoice: z.number().int().nullable(),
});
export type MemberProfile = z.infer<typeof memberProfileSchema>;
