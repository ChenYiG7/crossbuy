import {
  BargainDisplayStatus,
  ORDER_INVALID_STATUSES,
  OrderStatus,
  type BargainDisplayStatusCode,
} from '@crossbuy/contract';

/**
 * 订单列表行投影的纯函数集（旧 Member/OrderType resolve* + OrderBarrain + parseSkuName 1:1）。
 * 全部无 IO——单测直锁行为；业务时区 Asia/Shanghai（unixToIso 由 utils 提供）。
 */

/** 旧 Order::$shipReasonMadeInChina（item_location 拆分用） */
export const MADE_IN_CHINA_YES = 'MADE_IN_CHINAあり';
export const MADE_IN_CHINA_NO = 'MADE_IN_CHINAなし';

/** mark_flag 位占位（旧 MARK_FLAG_FAVORITE_POSITION=0 / ARRIVAL_POSITION=2，两位一标记） */
export const MARK_FLAG_FAVORITE_POSITION = 0;
export const MARK_FLAG_ARRIVAL_POSITION = 2;

/** 旧 config('bargain.display_from','2026-11-01') Asia/Tokyo 零点秒（JST=UTC+9） */
export function bargainDisplayFromSec(dateStr: string): number {
  const [y = 0, m = 1, d = 1] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) - 9 * 3600;
}

/** item_location 拆分：禁运原因（去 MADE_IN_CHINA 词）/ 中国制造标记（只留 MADE_IN_CHINA 词） */
export function splitItemLocation(itemLocation: string | null): {
  reason: string | null;
  madeInChina: string | null;
} {
  if (!itemLocation) return { reason: null, madeInChina: null };
  const parts = itemLocation.split(' ');
  const madeInChinaWords = parts.filter((w) => w === MADE_IN_CHINA_YES || w === MADE_IN_CHINA_NO);
  const reasonWords = parts.filter((w) => w !== MADE_IN_CHINA_YES && w !== MADE_IN_CHINA_NO);
  return { reason: reasonWords.join(' ') || null, madeInChina: madeInChinaWords.join(' ') || null };
}

/**
 * 旧 Order::parseSkuName 1:1：sku_name 的 `<font color=red>名[:：<font color=green>值` 标签解析；
 * 空 sku_name 回退 goodssize（尺码）/ goodscolor（颜色）。
 */
export function parseSkuName(
  skuName: string,
  goodsSize: string | null,
  goodsColor: string | null,
): Array<{ name: string; value: string }> {
  const detail: Array<{ name: string; value: string }> = [];
  if (!skuName) {
    if (goodsSize) detail.push({ name: '尺码', value: goodsSize });
    if (goodsColor) detail.push({ name: '颜色', value: goodsColor });
    return detail;
  }
  // 去除 \u00A0 / &nbsp;（旧 preg_replace('/\x{00A0}|&nbsp;/u', '', ...)）
  const cleaned = skuName.replace(/\u00A0|&nbsp;/gu, '');
  // 旧正则：/<font\s*color=red>(.+?)[:：]<.*?><font\s*color=green>(.+?)<.*?>/u
  const re = /<font\s*color=red>(.+?)[:：]<.*?><font\s*color=green>(.+?)<.*?>/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const name = (m[1] ?? '').replace(/<[^>]+>/g, '');
    const value = (m[2] ?? '').trim();
    detail.push({ name, value });
  }
  return detail;
}

/**
 * 「安くなった額」展示状态（旧 OrderBargain::of 1:1；docs/plans/09 §3.2）。
 * amount = (goodsprice − goodsprice1) × goodsnum，PHP round(x,2)；before_start/invalid/pending → null。
 */
export function bargainDisplayOf(
  addtimeSec: number,
  state: number,
  goodsPrice: number,
  goodsPrice1: number,
  goodsNum: number,
  displayFromSec: number,
): { status: BargainDisplayStatusCode; amount: string | null } {
  if (addtimeSec < displayFromSec)
    return { status: BargainDisplayStatus.BEFORE_START, amount: null };
  if ((ORDER_INVALID_STATUSES as readonly number[]).includes(state)) {
    return { status: BargainDisplayStatus.INVALID, amount: null };
  }
  if (goodsPrice1 > 0 && goodsPrice1 < goodsPrice && goodsNum > 0) {
    const amount = Math.round((goodsPrice - goodsPrice1) * goodsNum * 100) / 100;
    return { status: BargainDisplayStatus.SAVED, amount: amount.toFixed(2) };
  }
  if (state === OrderStatus.WAIT_CREATE)
    return { status: BargainDisplayStatus.PENDING, amount: null };
  return { status: BargainDisplayStatus.NONE, amount: '0.00' };
}

/** 旧 resolvePlatformOrderNoField：extend JSON 的 platform_order_no（解析失败/缺失 → ''） */
export function readExtendField(extend: string | null, field: string): string {
  if (!extend) return '';
  try {
    const parsed: unknown = JSON.parse(extend);
    const obj = parsed as Record<string, unknown> | null;
    const v = obj?.[field];
    return v === undefined || v === null ? '' : String(v);
  } catch {
    return '';
  }
}
