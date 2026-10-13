export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 页码归一：<1 归 1（防越界） */
export function normalizePage(page: number | undefined | null): number {
  const n = page ?? 1;
  return n < 1 ? 1 : Math.floor(n);
}

/** 每页条数归一：<1 归 1、缺省 20、上限 100（双层钳制的服务端侧） */
export function normalizePageSize(size: number | undefined | null): number {
  const n = size ?? DEFAULT_PAGE_SIZE;
  const clamped = n < 1 ? 1 : n;
  return clamped > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : Math.floor(clamped);
}
