<script setup lang="ts">
/**
 * DWG / DWF 预览占位。
 *
 * DWG 是 Autodesk 的专有二进制容器，浏览器里没有可用的纯 JS 解码器；强行按文本读只会
 * 得到乱码。这里明确告诉用户「不支持」并给出两条可操作路径：在 CAD 软件里另存为 DXF，
 * 或者直接用系统应用打开原文件。
 */
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

defineProps<{ tab: PreviewTab }>();
const t = i18n.global.t;
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ tab.name }}</span>
      <span class="shrink-0">{{ t("preview.viewer.legacyCad.label") }}</span>
    </div>

    <div data-testid="legacy-cad-viewer" class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="rounded-[calc(8px*var(--gw-radius-scale))] border border-line-2 bg-panel-2 p-4">
        <p class="text-[13px] text-foreground">{{ t("preview.viewer.legacyCad.unsupported") }}</p>
        <p class="mt-1.5 text-[12px] leading-relaxed text-dim2">{{ t("preview.viewer.legacyCad.hint") }}</p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <PreviewExternalButton :tab="tab" />
        </div>
      </div>
    </div>
  </div>
</template>
