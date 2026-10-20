import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

/**
 * GreyWork 按钮配方 —— 和 shadcn 同机制（cva + reka Primitive + cn），但用**本项目**的
 * 紧凑皮肤，不继承上游 `components/ui/button` 的 `buttonVariants`。
 *
 * 为什么另起一份而不是复用 ui/button（见 docs/ui-design.md「Button 不迁移」一节的反面）：
 * 上游基类里的 `h-9` / `bg-primary` / `[&_svg…]:size-4` / `ring-3` 会和本项目的
 * 11–12px 字号、`--accent` 语义、`focus-visible:outline-cyan` 焦点环直接冲突，twMerge
 * 需逐个体检。本配方的 base 只收**普适且有益**的行为（焦点环 a11y / disabled / 过渡 /
 * 指针），视觉由 variant·size·radius 三轴表达，和实测 371 个原生按钮的 class 聚类一致。
 *
 * 转换约定：调用点残留的一次性 class 原样塞进 `class`（twMerge 后生效，同属性后者胜）；
 * 真正一次性的异形按钮（带 logo 的品牌入口等）不强迁。
 */
export const gwButtonVariants = cva(
  "inline-flex items-center justify-center shrink-0 cursor-pointer transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        /** 主操作：实心 --accent 底。 */
        primary: "bg-accent text-accent-ink hover:opacity-90",
        /** 次操作：面板底，悬停提亮一档。 */
        secondary: "bg-panel-2 text-foreground hover:bg-panel",
        /** 描边：透明底 + 线框，悬停加深线框。 */
        outline: "border border-line text-foreground hover:border-line-2",
        /** 安静按钮：弱化文字，悬停提亮为前景色（无底）。 */
        ghost: "text-dim hover:text-foreground",
        /** 安静按钮带底：悬停铺面板底（图标工具按钮常用）。 */
        subtle: "text-dim hover:bg-panel-2 hover:text-foreground",
        /** 危险/删除：橙红文字，悬停淡底。 */
        danger: "text-orange hover:bg-orange/10",
      },
      size: {
        /** 文字按钮，三档高度对齐实测 h-6/h-7/h-9 + 11/11.5/12px。 */
        xs: "h-6 gap-1 px-2 text-[11px]",
        sm: "h-7 gap-1.5 px-2.5 text-[11.5px]",
        md: "h-9 gap-2 px-3 text-[12px]",
        /** 纯图标方钮。 */
        "icon-xs": "size-6",
        icon: "size-7",
        "icon-lg": "size-9",
      },
      radius: {
        sm: "rounded-[calc(5px*var(--gw-radius-scale))]",
        md: "rounded-[calc(6px*var(--gw-radius-scale))]",
        lg: "rounded-[calc(7px*var(--gw-radius-scale))]",
        xl: "rounded-[calc(8px*var(--gw-radius-scale))]",
        full: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "sm",
      radius: "lg",
    },
  },
);

export type GwButtonVariants = VariantProps<typeof gwButtonVariants>;
