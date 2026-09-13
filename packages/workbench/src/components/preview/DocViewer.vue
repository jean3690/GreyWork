<script setup lang="ts">
/**
 * docx 预览：解析 OOXML → DOM 渲染（`lib/docx-parse.ts` + `DocxBlocks.vue`）。
 *
 * **为什么不再走 Univer Docs**：旧实现用正则抓 `w:p`，而表格单元格里的段落同样是 `w:p` ——
 * 一份带表格的文档会被拍平成一串松散段落，表格、图片、列表编号全部丢失。docx 本质是流式文档，
 * 段落/表格/图片在 HTML 里有一一对应的原生表达，保真度和实现成本都比塞进富文本编辑器的
 * 私有快照更划算，也顺带省掉 Univer Docs 那套 preset + CSS。
 *
 * **按正文宽度重排而不是整页缩放**（与 pptx 相反）：幻灯片是定版式的，缩放才对；
 * 文档是流式的，缩放会把字缩到读不清，让它在面板宽度内重排才是对的。
 */
import { computed, ref, toRef, watch } from "vue";
import DocxBlocks from "./DocxBlocks.vue";
import { usePreviewBinary } from "../../lib/preview-content";
import { parseDocx, type ParsedDocx } from "../../lib/docx-parse";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const doc = ref<ParsedDocx | null>(null);
const parseError = ref<string | null>(null);

/** 解析代次：切 tab 时自增，让还在 await 的旧解析自我放弃，避免把上一份内容画上去。 */
let generation = 0;

watch(
  data,
  async (bytes) => {
    const mine = ++generation;
    parseError.value = null;
    if (!bytes) {
      doc.value = null;
      return;
    }
    try {
      const parsed = await parseDocx(bytes);
      if (mine !== generation) return;
      doc.value = parsed;
    } catch (cause: unknown) {
      if (mine !== generation) return;
      doc.value = null;
      parseError.value = cause instanceof Error ? cause.message : String(cause);
    }
  },
  { immediate: true },
);

const blockCount = computed(() => doc.value?.blocks.length ?? 0);
const tableCount = computed(() => doc.value?.blocks.filter((block) => block.kind === "table").length ?? 0);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span>{{ blockCount > 0 ? `${blockCount} 个段落块${tableCount ? ` · ${tableCount} 张表格` : ""}` : "文档" }}</span>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-red-400">读取失败：{{ error }}</p>
    <p v-else-if="parseError" role="alert" class="px-4 py-3 text-[12px] text-red-400">
      无法解析该文档：{{ parseError }}。可在文件夹中打开原文件。
    </p>
    <p v-else-if="doc && blockCount === 0" class="px-4 py-3 text-[12px] text-dim2">这份文档没有正文内容。</p>

    <div v-show="!loading && !error && !parseError" data-testid="doc-viewer" class="min-h-0 flex-1 overflow-y-auto p-3">
      <!-- 纸张：文档是深色底上的浅色页，和 Word 的观感一致；正文颜色交给 run 自己的 color。
           纸色走 --paper（暗态压暗一档），不用画布色 —— 正文色来自文件本身。 -->
      <article
        v-if="doc"
        class="mx-auto rounded-[6px] border border-line-2 bg-paper px-6 py-7 text-[14px] text-paper-ink shadow-sm"
        :style="{ maxWidth: `${doc.contentWidth}px` }"
      >
        <DocxBlocks :blocks="doc.blocks" />
      </article>
    </div>
  </div>
</template>
