<script setup lang="ts">
/**
 * 原生 `title=` 的替代：把默认插槽那**一个**元素包成 tooltip 触发器。
 *
 * 为什么不用 title：
 *  - 样式不可控 —— 原生提示跟项目的紧凑规格无关，各平台长得也不一样；
 *  - 出得慢、不能自定义延迟；
 *  - 对可聚焦的触发器（button / input）能在**键盘聚焦**时出现，而原生 title 只认悬停；
 *  - 内容挂在 `aria-describedby` 上，读屏会念。
 *
 * 注意：第 3 条只对**可聚焦元素**成立。包一个不可聚焦的 `<span>`（如截断的路径文本）时，
 * 提示仍然只认悬停 —— 和原生 title 一样，不是退步，但也别指望它变得键盘可达。
 *
 * 判断准则：只有当**提示本身就是在解释「为什么不能用」**时，才需要把 `disabled` 换成
 * `aria-disabled`（否则提示永远弹不出来，等于写下永不执行的死代码）。按钮只是瞬时忙
 * （执行中）而提示讲的是「点了会做什么」，那就照常用 disabled —— 忙完提示自然能出。
 * 换 `aria-disabled` 时务必确认点击处理器自带守卫。
 *
 * 用法（触发器必须是单个元素，reka 的 as-child 要求）：
 *   <Hint text="导出为 JSON">
 *     <button type="button" …>…</button>
 *   </Hint>
 *
 * `text` 为空时直接透传插槽，不生成任何 trigger/portal —— 条件文案（如
 * `:text="installed ? hint : undefined"`）因此不需要在调用点写 v-if。
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 自带 TooltipProvider，而不是靠 Shell 挂一个全局的。
 *
 * 原因：reka 的 TooltipRoot 在拿不到 provider 上下文时**直接抛**
 * （`Injection Symbol(TooltipProviderContext) not found`，抛点在 reka 的 createContext.ts）。
 * 那样「哪些测试要多包一层 provider」就成了隐式耦合 —— 不只是用到 Hint 的组件，
 * 连它们的祖先组件的测试都会炸：第一批迁移实测有 32 条用例因此失败。
 *
 * 代价是每个提示各自计时，失去全局 provider 的 skipDelay 接力（相邻图标之间第二个提示
 * 会立刻出现）。这点手感上的收益不值一份到处踩的测试税；若将来确实需要接力，
 * 再改成全局 provider + 一个统一的测试挂载助手。
 */
withDefaults(
  defineProps<{
    text?: string | null;
    /** 默认向上：胶囊/图标多在底栏，向上更不容易出屏。 */
    side?: "top" | "right" | "bottom" | "left";
    /** 与触发器的间距。 */
    sideOffset?: number;
    /** 长文案（如完整路径）时才需要，交给弹层换行而不是撑成一条。 */
    multiline?: boolean;
  }>(),
  { text: null, side: "top", sideOffset: 4, multiline: false },
);
</script>

<template>
  <TooltipProvider v-if="text" :delay-duration="300">
    <Tooltip>
      <TooltipTrigger as-child>
        <slot></slot>
      </TooltipTrigger>
      <TooltipContent :side="side" :side-offset="sideOffset" :class="multiline ? 'max-w-[320px] leading-relaxed break-all' : undefined">
        {{ text }}
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <slot v-else></slot>
</template>
