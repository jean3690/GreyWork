<script setup lang="ts">
/**
 * 老格式 Office（.doc / .xls / .ppt 等）预览占位。
 *
 * **为什么不渲染**：这些是 OLE2 复合文档（二进制的对象存储），不是 OOXML 的 ZIP + XML。
 * `docx-parse` / `pptx-parse` 读的是 OOXML，Univer / exceljs 只认 xlsx —— 全都读不了。
 *
 * **为什么必须有这个 viewer**：在这之前 .doc 落到 `raw`，被 TextViewer 按 utf-8 读。
 * OLE2 的二进制头解码出来是满屏乱码，而且**不报错** —— 用户看到的是「文件坏了」，
 * 而不是「不支持这种格式」。本组件的职责就是把这件事说清楚，并指向系统里的 Office。
 *
 * 仍然走二进制读取 —— 走文本通道会把内容不可逆地解码损坏，而本组件存在的意义就是
 * 不再发生这件事。字节只用于嗅探容器类型。
 */
import { computed, ref, toRef, watch } from "vue";
import { sniffOfficeContainer, type OfficeContainer } from "../../lib/legacy-office";
import { usePreviewBinary } from "../../lib/preview-content";
import type { PreviewTab } from "../../stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const container = ref<OfficeContainer | null>(null);

/** 嗅探代次：切 tab 时自增，让还在等字节的旧嗅探自我放弃。 */
let generation = 0;

watch(
  data,
  (bytes) => {
    const mine = ++generation;
    if (!bytes) {
      container.value = null;
      return;
    }
    const sniffed = sniffOfficeContainer(bytes);
    if (mine !== generation) return;
    container.value = sniffed;
  },
  { immediate: true },
);

const extension = computed(() => {
  const parts = props.tab.name.split(".");
  return parts.length > 1 ? (parts.pop() ?? "").toLowerCase() : "";
});

/**
 * 扩展名被改错的情况：内容其实是 OOXML。给出可操作提示，
 * 而不是和真·老格式一样笼统地说「不支持」。
 */
const actualFormat = computed(() => (container.value?.kind === "ooxml" ? container.value.format : null));

const headline = computed(() => {
  if (actualFormat.value) return `这个文件其实是 .${actualFormat.value}`;
  if (container.value?.kind === "ole2") return `不支持预览 .${extension.value} 老格式`;
  if (container.value?.kind === "zip") return "认不出这个文件的具体格式";
  return "认不出这个文件";
});

const detail = computed(() => {
  if (actualFormat.value) {
    return `扩展名被改成了 .${extension.value}，内容却是 .${actualFormat.value}。把文件改名成 .${actualFormat.value} 就能在预览里打开。`;
  }
  if (container.value?.kind === "ole2") {
    return `.${extension.value} 是 OLE2 复合文档，需要在 Word / Excel / PowerPoint 或 LibreOffice 里打开。`;
  }
  return "文件内容与扩展名对不上，无法判断格式。";
});

/** 工具条摘要：内容其实是可渲染的 OOXML 时不能说「不支持预览」，否则与正文自相矛盾。 */
const summary = computed(() => {
  const label = extension.value ? `.${extension.value}` : "老格式文档";
  return actualFormat.value ? `${label} · 实为 .${actualFormat.value}` : `${label} · 不支持预览`;
});

/** 「用系统应用打开」只对真的渲染不了的情况才有意义；改名就能看的不必绕道系统应用。 */
const showSystemAppHint = computed(() => actualFormat.value === null);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span>{{ summary }}</span>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-red-400">读取失败：{{ error }}</p>

    <div v-else data-testid="legacy-office-viewer" class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="rounded-[8px] border border-line-2 bg-panel-2 p-4">
        <p class="text-[13px] text-foreground">{{ headline }}</p>
        <p class="mt-1.5 text-[12px] leading-relaxed text-dim2">{{ detail }}</p>
        <p v-if="showSystemAppHint" class="mt-2.5 text-[12px] leading-relaxed text-dim2">
          可以点上方工具栏的「用系统应用打开」用本机的 Office 查看原文件。
        </p>
      </div>
    </div>
  </div>
</template>
