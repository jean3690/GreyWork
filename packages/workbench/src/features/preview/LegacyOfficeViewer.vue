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
 * 不再发生这件事。字节用于嗅探容器类型与展示文件体积（byteLength，无需额外 stat）。
 */
import { computed, ref, toRef, watch } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { sniffOfficeContainer, type OfficeContainer } from "@/lib/legacy-office";
import { formatBytes } from "@/lib/attachments";
import { openWithSystemApp, resolveTabDiskPath } from "@/lib/open-external";
import { usePreviewBinary } from "@/lib/preview-content";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";
import { notify } from "@/stores/notice";

/** 面板文案全部走 i18n（含这条查看器自己的说明文字）。 */
const t = i18n.global.t;

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
  if (actualFormat.value) return t("preview.viewer.legacyOffice.actualFormat", { format: actualFormat.value });
  if (container.value?.kind === "ole2") return t("preview.viewer.legacyOffice.unsupportedLegacy", { ext: extension.value });
  if (container.value?.kind === "zip") return t("preview.viewer.legacyOffice.unknownFormat");
  return t("preview.viewer.legacyOffice.unknown");
});

const detail = computed(() => {
  if (actualFormat.value) {
    return t("preview.viewer.legacyOffice.renamed", { ext: extension.value, format: actualFormat.value });
  }
  if (container.value?.kind === "ole2") {
    return t("preview.viewer.legacyOffice.ole2", { ext: extension.value });
  }
  return t("preview.viewer.legacyOffice.mismatch");
});

/** 字节已加载后的人类可读体积；web 源不存在老格式文档，大小照常显示无妨。 */
const sizeText = computed(() => (data.value ? formatBytes(data.value.byteLength) : null));

/** 工具条摘要：内容其实是可渲染的 OOXML 时不能说「不支持预览」，否则与正文自相矛盾。 */
const summary = computed(() => {
  const label = extension.value ? `.${extension.value}` : t("preview.viewer.legacyOffice.fallbackLabel");
  const status = actualFormat.value
    ? t("preview.viewer.legacyOffice.realFormat", { format: actualFormat.value })
    : t("preview.viewer.legacyOffice.unsupported");
  return sizeText.value ? `${label} · ${status} · ${sizeText.value}` : `${label} · ${status}`;
});

/** 「用系统应用打开」只对真的渲染不了的情况才有意义；改名就能看的不必绕道系统应用。 */
const showSystemAppHint = computed(() => actualFormat.value === null);

/**
 * 磁盘孪生路径，没有则 null（按钮不出现）。与 PreviewSider 工具栏同一套判定：
 * 浏览器态恒为 null，没有磁盘通道，按钮留着只会点了没反应。
 */
const externalPath = computed(() => {
  if (!isTauriRuntime()) return null;
  return resolveTabDiskPath(props.tab);
});

async function openExternal(): Promise<void> {
  const path = externalPath.value;
  if (!path) return;
  if (!(await openWithSystemApp(path))) {
    notify({
      kind: "warning",
      key: "legacy-office-open-external",
      title: t("fileOp.openFailed"),
      detail: t("fileOp.openFailedDetail", { path }),
    });
  }
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span>{{ summary }}</span>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <p v-else-if="error" role="alert" class="px-4 py-3 text-[12px] text-red-400">
      {{ t("preview.common.readFailed", { detail: error }) }}
    </p>

    <div v-else data-testid="legacy-office-viewer" class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="rounded-[8px] border border-line-2 bg-panel-2 p-4">
        <p class="text-[13px] text-foreground">{{ headline }}</p>
        <p class="mt-1.5 text-[12px] leading-relaxed text-dim2">{{ detail }}</p>
        <template v-if="showSystemAppHint">
          <p class="mt-2.5 text-[12px] leading-relaxed text-dim2">
            {{ t("preview.viewer.legacyOffice.systemAppHint") }}
          </p>
          <button
            v-if="externalPath"
            type="button"
            data-testid="legacy-office-open-external"
            class="mt-3 cursor-pointer rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            @click="openExternal()"
          >
            {{ t("preview.common.openExternal") }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
