import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * className 合并（shadcn 约定）：clsx 管条件拼接，tailwind-merge 管后写类覆盖先写类
 * （如外部传 `px-4` 覆盖组件内置 `px-2`）。三 app 与共享组件共用这一个实现。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
