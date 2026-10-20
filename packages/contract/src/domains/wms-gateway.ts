import { z } from 'zod';

/**
 * wms-gateway 域契约（**黑舟 WMS 适配层**，docs/04 §3.1；2026-10-20 对齐 haiou v2.0 前置期）。
 *
 * 定位：WMS 业务本体（仓储保管与计费/国内到库/货架 PDA/一件代发库存统计）已外迁第三方
 * **黑舟 WMS**（haiou 11 号 §0，2026-12 底左右上线），本域**不迁移业务**，只做两层薄事：
 *   ① 事实面（黑舟 → 本仓）：黑舟事件归一化后驱动 `dg_order` 仓储状态——order/logistics
 *      域切写后写方从 PHP 适配层移交本仓，须与域切写同窗口就绪（docs/04 §5.6）
 *   ② 指令面（本仓 → 黑舟）：入库通知 / 出库发货指令 / 取消回改
 *
 * ⚠ 黑舟协议尚未定版（haiou 前置期 P0.2 产出《WMS 剥离边界表》+ 状态映射表后填充，
 * TODO(#20)）——本契约先定**归一化中间模型**（docs/07 §5-2：统一中间模型，平台差异只许
 * 存在于适配器 Translator），黑舟原始报文到达后在适配器内翻译成这里的形状，禁把黑舟
 * 字段散落进业务域。
 */

/** 事实面事件族（haiou 11 号 §0.2 事实面：到库、上架、检品完成、出库、费用事实） */
export const WMS_FACT_KIND = {
  /** 国内到库（旧 DgArrival；黑舟承接后事件驱动） */
  ARRIVAL: 'arrival',
  /** 上架（货架/格子） */
  PUT_SHELF: 'put_shelf',
  /** 检品完成 */
  CHECK_DONE: 'check_done',
  /** 出库（发货/货架出库） */
  SHELF_OUT: 'shelf_out',
  /** 仓储计费事实（回传入账——R2 五方对账第五方，docs/04 §12.1；当前不消费，接入随 R2） */
  STORAGE_FEE: 'storage_fee',
} as const;
export type WmsFactKind = (typeof WMS_FACT_KIND)[keyof typeof WMS_FACT_KIND];

/** 指令面命令族（haiou 11 号 §0.2 指令面：入库通知、出库/发货指令、取消/回改） */
export const WMS_COMMAND_KIND = {
  /** 入库通知（入仓预告） */
  INBOUND_NOTICE: 'inbound_notice',
  /** 出库/发货指令 */
  OUTBOUND: 'outbound',
  /** 取消/回改 */
  CANCEL: 'cancel',
} as const;
export type WmsCommandKind = (typeof WMS_COMMAND_KIND)[keyof typeof WMS_COMMAND_KIND];

/** 归一化事实（黑舟 → 本仓；Translator 的翻译目标，业务域只认这个形状） */
export const wmsFactSchema = z.object({
  /** 幂等键：黑舟事件唯一 id（协议缺省时由适配器用「事件族+业务单号+时间」拼装并登记） */
  eventId: z.string().min(1).max(128),
  kind: z.enum([
    WMS_FACT_KIND.ARRIVAL,
    WMS_FACT_KIND.PUT_SHELF,
    WMS_FACT_KIND.CHECK_DONE,
    WMS_FACT_KIND.SHELF_OUT,
    WMS_FACT_KIND.STORAGE_FEE,
  ]),
  /** 关联订单 `dg_order.oid`（状态驱动型事实必填；校验在域服务，schema 保持宽进） */
  oid: z.number().int().positive().optional(),
  /** 黑舟侧状态码（状态映射表的 key 之一；协议定版后由 Translator 填） */
  wmsStatus: z.string().min(1).max(64),
  /** 事件发生时间（ISO 8601 含时区；旧表 INT unix 列由 order 域仓储按 Asia/Shanghai 转换） */
  occurredAt: z.string().min(1),
  /** 黑舟原始报文（docs/07 §5-3：raw 必存——R1 无新表，落结构化日志留痕，R2 迁事件表） */
  raw: z.unknown(),
});
export type WmsFact = z.infer<typeof wmsFactSchema>;

/** 归一化指令（本仓 → 黑舟；箱数/物流号等载荷随协议定版扩充，TODO(#20)） */
export const wmsCommandSchema = z.object({
  kind: z.enum([
    WMS_COMMAND_KIND.INBOUND_NOTICE,
    WMS_COMMAND_KIND.OUTBOUND,
    WMS_COMMAND_KIND.CANCEL,
  ]),
  /** 关联订单 `dg_order.oid`（指令携带订单号，haiou 11 号 §0.2 指令面） */
  oid: z.number().int().positive(),
  /** 备注/补充载荷（协议定版前的透传位） */
  note: z.string().max(500).optional(),
});
export type WmsCommand = z.infer<typeof wmsCommandSchema>;

/**
 * 状态映射表条目：「黑舟事件族 + 黑舟状态码」→ `dg_order.state` 目标态。
 *
 * ⚠ 映射内容等 haiou 前置期 P0.2 产出（TODO(#20)）；**未命中 = fail-fast**（haiou 11 号
 * §0.2：无法映射的差异必须显式登记、不得静默忽略）。cas 语义见 docs/07 §4：
 * order 域按 `fromStates` 白名单做 `UPDATE ... WHERE state IN (...)` 条件推进。
 */
export interface WmsStateMapping {
  kind: WmsFactKind;
  /** 黑舟状态码（协议定版后 1:1 抄录，禁本仓自造） */
  wmsStatus: string;
  /** `dg_order.state` 目标值（词表 = contract order 域 OrderStatus；仓储状态段由 P0.2 定） */
  toState: number;
  /** 允许的当前态白名单（cas from；P0.2 定版时逐条收窄，禁留「不限」上线） */
  fromStates: number[];
}
