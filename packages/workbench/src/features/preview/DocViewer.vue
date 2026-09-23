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
 *
 * **可就地编辑文本**：正文 run 是 contenteditable，改字经 `patchDocxText` 只补 word/document.xml
 * 里对应 w:t、其余字节原样保留（不改结构 / 不动样式）。脏标记、保存、关闭前确认由外壳统一提供。
 */
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import DocxBlocks from "@/features/preview/DocxBlocks.vue";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { usePreviewBinary } from "@/lib/preview-content";
import { parseDocx, type ParsedDocx } from "@/lib/docx-parse";
import { patchDocxText } from "@/lib/docx-serialize";
import { registerPreviewSaver, unregisterPreviewSaver, writePreviewBytes } from "@/lib/preview-save";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

/** 查看器可能被直接 mount（测试），不依赖宿主的 i18n 插件，故用全局实例。 */
const t = i18n.global.t;

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const doc = ref<ParsedDocx | null>(null);
const parseError = ref<string | null>(null);

/** 编辑缓冲：w:t 序号 → 新文本；保存时对基线字节做就地补丁。 */
const edits = new Map<number, string>();
/** 有未保存改动。外壳据此显示脏点 / 启用保存。 */
const dirty = ref(false);
/** 回写基线：初次为读入字节，保存后替换为刚写出的字节（w:t 编号不变，可继续编辑）。 */
let baseline: Uint8Array | null = null;

/** 解析代次：切 tab 时自增，让还在 await 的旧解析自我放弃，避免把上一份内容画上去。 */
let generation = 0;

watch(
  data,
  async (bytes) => {
    const mine = ++generation;
    parseError.value = null;
    if (!bytes) {
      doc.value = null;
      baseline = null;
      edits.clear();
      dirty.value = false;
      return;
    }
    try {
      const parsed = await parseDocx(bytes);
      if (mine !== generation) return;
      doc.value = parsed;
      // 载入新内容即重置编辑态：基线换成这份字节，旧编辑作废。
      baseline = bytes;
      edits.clear();
      dirty.value = false;
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

/** 工具条摘要：段数 + （有表格时）表格数；还没有正文时退化成「文档」这个词本身。 */
const summary = computed(() => {
  if (blockCount.value === 0) return t("preview.viewer.doc.label");
  const blocks = t("preview.viewer.doc.blocks", { count: blockCount.value });
  return tableCount.value ? blocks + t("preview.viewer.doc.tables", { count: tableCount.value }) : blocks;
});

/** 某个 run 改字：记进缓冲并标脏（编号是 w:t 的文档序，保存时定位到原 XML 节点）。 */
function onRunEdit(editId: number, text: string): void {
  edits.set(editId, text);
  dirty.value = true;
}

/** 保存：对基线字节就地补丁后回写来源；随后以新字节为基线重解析（w:t 编号不变）。 */
async function save(): Promise<void> {
  if (!baseline || edits.size === 0) return;
  const bytes = await patchDocxText(baseline, edits);
  await writePreviewBytes(props.tab, bytes);
  baseline = bytes;
  doc.value = await parseDocx(bytes);
  edits.clear();
  dirty.value = false;
}

registerPreviewSaver(props.tab.id, { dirty, save });
onBeforeUnmount(() => unregisterPreviewSaver(props.tab.id));
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span>{{ summary }}</span>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-red-400">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else-if="parseError" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-red-400">{{ t("preview.viewer.doc.parseFailed", { detail: parseError }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <p v-else-if="doc && blockCount === 0" class="px-4 py-3 text-[12px] text-dim2">
      {{ t("preview.viewer.doc.empty") }}
    </p>

    <div v-show="!loading && !error && !parseError" data-testid="doc-viewer" data-scroll-root class="min-h-0 flex-1 overflow-y-auto p-3">
      <!-- 纸张：文档是深色底上的浅色页，和 Word 的观感一致；正文颜色交给 run 自己的 color。
           纸色走 --paper（暗态压暗一档），不用画布色 —— 正文色来自文件本身。 -->
      <article
        v-if="doc"
        data-selection-scope
        class="mx-auto rounded-[6px] border border-line-2 bg-paper px-6 py-7 text-[14px] text-paper-ink shadow-sm"
        :style="{ maxWidth: `${doc.contentWidth}px` }"
      >
        <DocxBlocks :blocks="doc.blocks" @edit="onRunEdit" />
      </article>
    </div>
  </div>
</template>
