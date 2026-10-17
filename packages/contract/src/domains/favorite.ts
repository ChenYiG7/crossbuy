import { z } from 'zod';

/**
 * 收藏域契约（member 域属主旧表 `dg_favorite`，M0.5 映射）。
 *
 * 规则正本 = 旧系统三处（haiou，只读参考）：
 *   1. `AddFavoriteMutation`（GraphQL）：客户端传商品快照（名/价/链接/图/商家），
 *      type 按 dfflag 分流（3 一件代发 / 1 普通代购），goodssite 按 platform 映射
 *   2. `DeleteFavoriteMutation`：按 fid 删除（旧入参是逗号串多选；R1 REST 化单删，
 *      批量由端上循环——行为差异登记 docs/plans/08）
 *   3. `ListFavoriteQuery` + `FavoriteController`（REST /api/v1/favorites）：
 *      type 过滤二值语义（=3 只看代发；其余 = 非代发含 NULL）、fid 倒序、分页
 *
 * ⚠ 复现怪癖：`dg_favorite` **无 (uid, goodsurl) 唯一键**，旧系统「先查后插」
 *   （并发同 URL 仍可能插出重复行）——R1 1:1 复现该行为并登记 docs/plans/08；
 *   禁自作聪明 upsert（会把两个不同商品的撞键当同一实体，见 MEMORY 血泪坑 1）。
 */

/** 收藏类型（旧 `App\Models\Favorite`：TYPE_DAIGOU=1 / TYPE_DAIFA=3） */
export const FAVORITE_TYPE = {
  DAIGOU: 1, // 普通代购
  DAIFA: 3, // 一件代发
} as const;
export type FavoriteType = (typeof FAVORITE_TYPE)[keyof typeof FAVORITE_TYPE];

/** 商品平台（旧 AddFavoriteMutation switch：taobao→淘宝 / 1688→1688 / default→其他） */
export const FAVORITE_PLATFORM = {
  TAOBAO: 'taobao',
  '1688': '1688',
  OTHER: 'other',
} as const;

/** 平台 → 旧列 goodssite 存储值（旧 `Order::TYPE_TAOBAO='淘宝'` / `TYPE_1688='1688'`） */
export const GOODS_SITE_BY_PLATFORM: Record<string, string> = {
  taobao: '淘宝',
  '1688': '1688',
  other: '其他',
};

/** 新增收藏入参（旧 AddFavoriteMutation args 的 REST 化；商品快照由客户端传，域内不跨域读商品表） */
export const favoriteCreateSchema = z.object({
  /** 商品名称 */
  name: z.string().min(1).max(255),
  /** 平台（旧入参是自由字符串走 switch default；REST 面收口为枚举，未知值 400 不静默归「其他」） */
  platform: z.enum(['taobao', '1688', 'other']),
  /** 商家昵称 */
  nick: z.string().min(1).max(50),
  /** 商品价格（快照值；库里是 float——旧结构不动，读出任经 utils/money 单入口序列化） */
  price: z.number(),
  /** 商品链接 */
  detailUrl: z.string().min(1).max(255),
  /** 商品图片（旧 mutation 可选） */
  picture: z.string().max(255).optional(),
});
export type FavoriteCreate = z.infer<typeof favoriteCreateSchema>;

/** 收藏列表查询（旧 ListFavoriteQuery args + FavoriteController 分页；query 串全经 coerce） */
export const favoriteListQuerySchema = z.object({
  /**
   * 类型过滤——**二值语义**（旧代码原样）：传 3 只看一件代发；
   * 传 1 或不传 = 非代发（type != 3 **含 NULL**，旧 `whereNull('type')->orWhere('type','!=',3)`）
   */
  type: z.coerce
    .number()
    .int()
    .refine((v) => v === FAVORITE_TYPE.DAIGOU || v === FAVORITE_TYPE.DAIFA)
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type FavoriteListQuery = z.infer<typeof favoriteListQuerySchema>;

/** 收藏行（旧 listFavorite 字段 + REST 控制器出参的合并；时间戳 ISO 化见下） */
export const favoriteSchema = z.object({
  fid: z.number().int().positive(),
  uid: z.number().int(),
  uname: z.string(),
  typeid: z.number().int(),
  type: z.number().int().nullable(),
  goodsUrl: z.string(),
  goodsName: z.string(),
  /** 价格快照：字符串承载（禁 JS 浮点回传；旧 GraphQL 回 float，REST 面修正为字符串） */
  goodsPrice: z.string(),
  goodsImg: z.string().nullable(),
  goodsSeller: z.string().nullable(),
  sellerUrl: z.string().nullable(),
  goodsSite: z.string().nullable(),
  siteUrl: z.string().nullable(),
  /** 收藏时间：ISO 字符串（Asia/Shanghai）。旧 GraphQL 回 int unix 时间戳——REST 面 ISO 化 */
  createdAt: z.string(),
});
export type Favorite = z.infer<typeof favoriteSchema>;
