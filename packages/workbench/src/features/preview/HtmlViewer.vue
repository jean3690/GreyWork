<script setup lang="ts">
/**
 * HTML 预览：渲染态（iframe）与源码态（CodeMirror）两切。
 *
 * iframe 的 sandbox **不给 `allow-scripts`**：这里的 HTML 多半是模型生成或管线拼装的
 * 产物，执行脚本没有任何正当理由，而一旦给了，产物就能读同源存储、发请求。
 * 只留 `allow-same-origin` 让相对样式生效即可；srcdoc 注入避免落临时文件。
 */
import { computed, ref, toRef } from "vue";
import TextViewer from "@/features/preview/TextViewer.vue";
import { usePreviewText } from "@/lib/preview-content";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewText(toRef(props, "tab"));

const mode = ref<"render" | "source">("render");
const srcdoc = computed(() => data.value ?? "");

const tabClass = (active: boolean): string =>
  [
    "h-[22px] cursor-pointer rounded-[6px] px-2 text-[11px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
      <button type="button" :class="tabClass(mode === 'render')" aria-label="渲染视图" @click="mode = 'render'">渲染</button>
      <button type="button" :class="tabClass(mode === 'source')" aria-label="源码视图" @click="mode = 'source'">源码</button>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-orange">读取失败：{{ error }}</p>
    <!-- 纸张化：外层是主题底，里面这张才是文档本身。被预览的 HTML 多半自带排版，
         把整个面板涂白会在暗色里糊出一大块眩光；不给脚本也改不了它的正文色，
         所以只能像 DocViewer 那样把它收成一张纸，而不是翻成深底。 -->
    <div v-else-if="mode === 'render'" class="min-h-0 flex-1 overflow-hidden bg-panel p-3">
      <iframe
        data-testid="html-viewer-frame"
        title="HTML 预览"
        sandbox="allow-same-origin"
        :srcdoc="srcdoc"
        class="size-full rounded-[6px] border border-line-2 bg-paper"
      />
    </div>
    <TextViewer v-else :tab="props.tab" class="min-h-0 flex-1" />
  </div>
</template>
