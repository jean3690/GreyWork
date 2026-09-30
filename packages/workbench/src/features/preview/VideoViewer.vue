<script setup lang="ts">
/**
 * 视频预览：原生 `<video>` 播放。
 *
 * **地址优先走宿主注册的 `gwmedia://` 流式协议**（桌面壳；见
 * `apps/desktop/src-tauri/src/media_protocol.rs`），媒体元素按 HTTP Range 自己拉片段 ——
 * 不读字节、不受 128MB 硬顶约束、拖动进度条可用。
 *
 * 早先的实现是「整份读进内存 → Blob → `blob:` URL」，实测是**不能用的**：IPC 全量传输 +
 * 主线程 `new Blob` 同步拷贝把界面卡死几秒，而 WebKit 还要把整个 blob 拉完才开始播。
 * 症状就是「一直转圈、不出画面、也没有任何报错」。所以 blob 这条路只留作没有自定义协议的
 * 宿主（服务端 / 浏览器预览）的兜底，见 `lib/preview-content.ts` 的 `resolvePreviewMedia`。
 *
 * blob 兜底里 **换内容与卸载都必须 revoke**，否则一次会话里看过的每个视频都留在内存里。
 *
 * 解码失败是常态而非异常：mov / mkv 能否播出取决于宿主运行时的解码器（WebKitGTK 走
 * GStreamer 插件，缺插件就没有画面）。`<video>` 的 error 事件是唯一能感知这件事的地方，
 * 所以它必须落到「用系统应用打开」，而不是留一个没有任何解释的黑框。
 */
import { computed, onUnmounted, ref, toRef, watch } from "vue";
import { extname } from "@greywork/core";
import { usePreviewMedia } from "@/lib/preview-content";
import PreviewExternalButton from "@/features/preview/PreviewExternalButton.vue";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

/** 扩展名 → MIME。给错 MIME 会让 WebKitGTK 直接拒绝播放，所以宁可查表也不猜。 */
const MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

const props = defineProps<{ tab: PreviewTab }>();

/** 直挂组件（测试）时可能没有 i18n 插件，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

const { data, loading, error } = usePreviewMedia(toRef(props, "tab"));

/** blob 兜底用的 object URL；流式那条路不建 blob，这里恒为 null。 */
const objectUrl = ref<string | null>(null);

/** 宿主解不出画面（缺解码器 / 容器不支持 / 协议返回了错误）。error 事件是唯一信号。 */
const playbackFailed = ref(false);

const extension = computed(() => extname(props.tab.path).toLowerCase());

/** 流式地址；没有自定义协议的宿主为 null。 */
const streamUrl = computed(() => (data.value?.kind === "stream" ? data.value.url : null));

/** 真正喂给 `<video>` 的地址：流式优先，其次是 blob。 */
const src = computed(() => streamUrl.value ?? objectUrl.value);

function release(): void {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
  objectUrl.value = null;
}

watch(
  data,
  (source) => {
    release();
    // 换文件就把失败态清掉：上一个视频解不出来，不代表这个也解不出来。
    playbackFailed.value = false;
    if (!source || source.kind === "stream") return;
    const type = MIME[extension.value] ?? "application/octet-stream";
    objectUrl.value = URL.createObjectURL(new Blob([source.bytes as BlobPart], { type }));
  },
  { immediate: true },
);

onUnmounted(release);
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="min-w-0 flex-1 truncate">{{ props.tab.name }}</span>
    </div>

    <p v-if="loading" class="px-4 py-3 text-[12px] text-dim2">{{ t("preview.common.loading") }}</p>
    <div v-else-if="error" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.common.readFailed", { detail: error }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else-if="playbackFailed" role="alert" class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="text-[12px] text-orange">{{ t("preview.video.unsupported", { ext: extension }) }}</span>
      <PreviewExternalButton :tab="tab" />
    </div>
    <div v-else-if="src" class="flex min-h-0 flex-1 items-center justify-center bg-black p-3">
      <video
        data-testid="video-viewer"
        :src="src"
        class="max-h-full max-w-full"
        controls
        playsinline
        preload="metadata"
        @error="playbackFailed = true"
      />
    </div>
  </div>
</template>
