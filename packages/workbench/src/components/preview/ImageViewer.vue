<script setup lang="ts">
/**
 * 图片预览。
 *
 * `URL.createObjectURL` 产生的 URL 会一直持有底层 Blob，直到显式 revoke。
 * 切几十次 tab 就是几十份图片留在内存里，所以**换内容与卸载时都必须 revoke** ——
 * 这是本组件唯一容易漏的地方。
 */
import { onUnmounted, ref, toRef, watch } from "vue";
import { usePreviewBinary } from "../../lib/preview-content";
import type { PreviewTab } from "../../stores/preview";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const props = defineProps<{ tab: PreviewTab }>();

const { data, loading, error } = usePreviewBinary(toRef(props, "tab"));

const objectUrl = ref<string | null>(null);

function release(): void {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = null;
}

watch(
  data,
  (bytes) => {
    release();
    if (!bytes) return;
    const ext = props.tab.path.split(".").pop()?.toLowerCase() ?? "";
    // 未知扩展给 octet-stream：浏览器仍会尝试嗅探，但不会因为错误 MIME 拒绝渲染。
    const blob = new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" });
    objectUrl.value = URL.createObjectURL(blob);
  },
  { immediate: true },
);

onUnmounted(release);
</script>

<template>
  <div class="flex size-full items-center justify-center overflow-auto bg-background p-3">
    <p v-if="loading" class="text-[12px] text-dim2">读取中…</p>
    <p v-else-if="error" role="alert" class="text-[12px] text-orange">读取失败：{{ error }}</p>
    <img
      v-else-if="objectUrl"
      data-testid="image-viewer"
      :src="objectUrl"
      :alt="props.tab.name"
      class="max-h-full max-w-full object-contain"
    />
  </div>
</template>
