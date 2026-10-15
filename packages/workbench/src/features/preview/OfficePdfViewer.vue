<script setup lang="ts">
/**
 * Office 文档的「高保真(PDF)」呈现：经 `office_convert_to_pdf` 让宿主用 LibreOffice
 * 把文件转成 PDF，再把字节喂给既有的 `PdfViewer`。
 *
 * 与云端 Office viewer 同一思路 ——「转换失败一律回落原生 viewer」，绝不出现「配了高保真反而
 * 打不开」。失败原因同时进通知（见 PreviewSurface 的 `onOfficeFallback`），因为回落之后界面
 * 上看不出发生过什么。
 *
 * **为什么不是常驻引擎**：LibreOffice 只在用户点开 Office 文档、且 soffice 在场时被按需调起，
 * 属于分层里的 B 驱动层（按需调用外部工具），不是内嵌编辑器，也不进主 bundle。
 */
import { computed, ref, watch } from "vue";
import { invoke } from "@greywork/host-ipc";
import { binaryPayload } from "@/state/workspaceFiles";
import { i18n } from "@/i18n";
import PreviewSkeleton from "@/features/preview/PreviewSkeleton.vue";
import PdfViewer from "@/features/preview/PdfViewer.vue";
import OfficeViewSwitch from "@/features/preview/OfficeViewSwitch.vue";
import type { PreviewTab } from "@/stores/preview";

const t = i18n.global.t;

const props = defineProps<{ tab: PreviewTab }>();

/** 换用原生 viewer。带上原因，PreviewSurface 负责把它显示出来。 */
const emit = defineEmits<{ fallback: [reason: string] }>();

const bytes = ref<Uint8Array | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** 转换代次：切 tab / 换 revision 时自增，让还在飞的旧请求自我放弃（同 usePreviewLoader）。 */
let generation = 0;

/**
 * 交给宿主读取的路径。
 *
 * `vfs` 产物只在其被落盘（`diskPath` 就位）后才走得通：纯内存产物没有宿主可读的路径，
 * 硬传相对路径过去只会撞授权拒绝，不如老实回落原生 viewer。
 */
const effectivePath = computed(() => (props.tab.source === "disk" ? props.tab.path : props.tab.diskPath ?? null));

async function convert(): Promise<void> {
  const path = effectivePath.value;
  if (!path) {
    emit("fallback", t("preview.viewer.officePdf.needsDisk"));
    return;
  }
  const mine = ++generation;
  loading.value = true;
  error.value = null;
  bytes.value = null;
  try {
    const result = await invoke<ArrayBuffer | Uint8Array>("office_convert_to_pdf", { path });
    if (mine !== generation) return;
    bytes.value = binaryPayload(result, "office_convert_to_pdf");
  } catch (cause: unknown) {
    if (mine !== generation) return;
    const reason = cause instanceof Error ? cause.message : String(cause);
    error.value = reason;
    emit("fallback", reason);
  } finally {
    if (mine === generation) loading.value = false;
  }
}

watch(
  [() => effectivePath.value, () => props.tab.revision],
  () => void convert(),
  { immediate: true },
);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden" data-testid="office-pdf-viewer">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="truncate">{{ t("preview.viewer.officePdf.title") }}</span>
      <OfficeViewSwitch :tab="tab" />
    </div>

    <PreviewSkeleton v-if="loading" />
    <div v-else-if="error" data-testid="office-pdf-error" class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="rounded-[calc(8px*var(--gw-radius-scale))] border border-line-2 bg-panel-2 p-4">
        <p class="text-[13px] text-foreground">{{ t("preview.viewer.officePdf.failedTitle") }}</p>
        <p class="mt-1.5 break-words text-[12px] leading-relaxed text-dim2">{{ error }}</p>
      </div>
    </div>
    <!-- 转换成功：把字节交给既有 PdfViewer；它自己管渲染、缩放、翻页、文本层。 -->
    <PdfViewer v-else-if="bytes" :tab="tab" :bytes="bytes" />
  </div>
</template>
