import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 class：clsx 处理条件值，tailwind-merge 消掉同属性冲突类。
 * shadcn-vue 组件内部统一用它拼接默认样式与外部传入的 class。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
