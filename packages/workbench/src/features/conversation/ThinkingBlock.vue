<script setup lang="ts">
/**
 * ThinkingBlock —— 一段推理流的折叠记录。
 *
 * 一条消息可以有多段：思考被正文或工具调用打断后，下一波思考另起一段、各自折叠，
 * 而不是把整轮推理并成消息头上那一坨。
 * 正在流的那一段默认展开，回合推进后自动收起为「已思考 Ns」细条。
 */
import { computed, ref, watch } from "vue";
import { Brain, ChevronDown } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { ThinkingSegment } from "@/types";

const props = defineProps<{
  segment: ThinkingSegment;
  /** 本段仍在流（消息流式中且它是末段）：默认展开 */
  live?: boolean;
}>();
const { t } = useI18n();

const open = ref(props.live === true);

// 段落进场时可能已经在流（v-for 新增），也可能流已结束（历史消息）——两种都要对齐。
watch(
  () => props.live,
  (live) => {
    open.value = live === true;
  },
);

const seconds = computed(() => t("chatView.seconds", { s: ((props.segment.endedAt - props.segment.startedAt) / 1000).toFixed(1) }));
</script>

<template>
  <section
    class="think my-[6px] mb-[2px] overflow-hidden rounded-[10px] border border-line bg-[image:var(--thought-gradient)]"
    data-testid="thinking-block"
    :data-open="open"
  >
    <button
      type="button"
      class="think__head flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left text-[12px] text-dim hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cyan [font-family:inherit]"
      :aria-expanded="open"
      @click="open = !open"
    >
      <Brain class="think__icon size-[14px] flex-none text-dim2" />
      <span class="think__label font-medium">{{ live ? t("chatView.thinking") : t("chatView.thought") }}</span>
      <span v-if="!live" class="think__dur ml-auto font-mono text-[11px] text-dim2">{{ seconds }}</span>
      <ChevronDown
        class="think__caret ml-auto flex-none text-dim2 transition-transform duration-150 [&.think\_\_caret--open]:rotate-180"
        :class="{ 'think__caret--open': open }"
      />
    </button>
    <p
      v-if="open"
      class="think__body m-0 whitespace-pre-wrap border-t border-line px-3 pb-2.5 pt-0.5 font-mono text-[12px] leading-[1.7] text-dim"
    >
      {{ segment.text }}
    </p>
  </section>
</template>
