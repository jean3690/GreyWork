<script setup lang="ts">
/**
 * 云端 Office 预览：把工作区里的 Office 文件交给第三方云服务渲染，用 iframe 嵌回来。
 *
 * 数据流：本组件只传**路径**给宿主（`office_preview_open`），宿主侧经 `WorkspaceFsAccess`
 * 校验授权根后自己读字节、上传到厂商 API、回一个可嵌入的文档地址。文件字节与厂商凭证
 * 都不经过渲染端 —— 凭证更只以环境变量名的形式存在，值从未离开 Rust 进程。
 *
 * 这是**可选**的呈现方式：本地 viewer 依然在，任何一步失败都回落给它（`fallback` 事件），
 * 绝不出现「配了云端反而打不开」。失败原因同时进通知，因为回落之后界面本身看不出发生过什么。
 */
import { computed, ref, watch } from "vue";
import { invoke } from "@greywork/host-ipc";
import { useSettingsStore } from "@/stores/settings";
import { useOfficeHostStore } from "@/stores/office-host";
import {
  canonicalOrigin,
  cloudOfficePath,
  cloudOfficeProviderFor,
  isOriginEmbeddable,
  unembeddableFrameOrigin,
} from "@/lib/office-preview";
import { i18n } from "@/i18n";
import { notify } from "@/stores/notice";
import PreviewSkeleton from "@/features/preview/PreviewSkeleton.vue";
import type { PreviewTab } from "@/stores/preview";

const t = i18n.global.t;

const props = defineProps<{ tab: PreviewTab }>();

/** 换用本地 viewer。带上原因，PreviewSurface 负责把它显示出来。 */
const emit = defineEmits<{ fallback: [reason: string] }>();

const settings = useSettingsStore();
const host = useOfficeHostStore();

const provider = computed(() => cloudOfficeProviderFor(props.tab, settings.officeProviders, settings.selectedOfficeProviderId));

const url = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

/** 取件代次：切 tab / 换 revision 时自增，让还在飞的旧请求自我放弃（同 usePreviewLoader）。 */
let generation = 0;

/**
 * 内嵌被拦的说明。
 *
 * 宿主 CSP 只放行白名单里的 origin，其余一律拦掉 —— iframe 白屏、控制台之外看不到报错，
 * 所以这里宁可回落本地 viewer 并**点名是哪个 origin**，让用户能去改配置（而不是干瞪白屏）。
 */
function frameBlockedReason(origin: string): string {
  const allowed = host.embeddableFrameOrigins.join("、") || t("preview.viewer.cloudOffice.frameBlockedNone");
  return t("preview.viewer.cloudOffice.frameBlocked", { origin, allowed });
}

/** 拉取可嵌入地址。凭证缺失/网络失败/域名不可内嵌都会带着原因走 `fallback`。 */
async function load(): Promise<void> {
  const mine = ++generation;
  const current = provider.value;
  const path = cloudOfficePath(props.tab);
  if (!current || !path) {
    emit("fallback", t("preview.viewer.cloudOffice.noProvider"));
    return;
  }
  loading.value = true;
  error.value = null;
  url.value = null;
  try {
    // 白名单是宿主进程级事实，一次会话取一次。取不到时 originsLoaded 保持 false，
    // 下面的两道校验都跳过（当作未知）—— 不因为一次查询失败就让云端预览全不可用。
    await host.ensureOrigins();
    if (mine !== generation) return;

    // 预检：配方声明的内嵌域名已知且不在白名单里 → 不必白传一次文件。
    if (host.originsLoaded) {
      const blocked = unembeddableFrameOrigin(current, host.embeddableFrameOrigins);
      if (blocked) {
        const reason = frameBlockedReason(blocked);
        error.value = reason;
        emit("fallback", reason);
        return;
      }
    }

    const result = await invoke<{ url: string; filename: string }>("office_preview_open", {
      path,
      recipe: current.recipe,
      credentialEnv: current.credentialEnv ?? null,
      headers: current.headers ?? null,
    });
    if (mine !== generation) return;

    // 权威校验：厂商实际返回的域名未必等于配方声明值，只能拿真地址比对。
    if (host.originsLoaded && !isOriginEmbeddable(result.url, host.embeddableFrameOrigins)) {
      const reason = frameBlockedReason(canonicalOrigin(result.url));
      error.value = reason;
      emit("fallback", reason);
      return;
    }

    url.value = result.url;
  } catch (cause: unknown) {
    if (mine !== generation) return;
    error.value = String(cause);
    emit("fallback", String(cause));
  } finally {
    if (mine === generation) loading.value = false;
  }
}

watch(
  // 逐个 getter：`() => [path, revision]` 每次求值都是新数组，Object.is 永不相等（同 preview-content.ts）。
  [() => cloudOfficePath(props.tab), () => props.tab.revision],
  () => void load(),
  { immediate: true },
);

/** iframe 地址的 origin，用于展示「内容来自哪里」（用户要判断是否信任这个域名）。 */
const viewOrigin = computed(() => {
  if (!url.value) return null;
  try {
    return new URL(url.value).origin;
  } catch {
    return null;
  }
});

function retry(): void {
  notify({
    kind: "info",
    key: "cloud-office-retry",
    title: t("preview.viewer.cloudOffice.retrying"),
    detail: error.value ?? undefined,
  });
  void load();
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1 text-[11px] text-dim2">
      <span class="truncate">{{ provider?.name ?? t("preview.viewer.cloudOffice.title") }}</span>
      <span v-if="viewOrigin" class="truncate text-dim">{{ viewOrigin }}</span>
    </div>

    <PreviewSkeleton v-if="loading" />

    <div v-else-if="error" data-testid="cloud-office-error" class="min-h-0 flex-1 overflow-y-auto p-4">
      <div class="rounded-[8px] border border-line-2 bg-panel-2 p-4">
        <p class="text-[13px] text-foreground">{{ t("preview.viewer.cloudOffice.failed") }}</p>
        <p class="mt-1.5 break-words text-[12px] leading-relaxed text-dim2">{{ error }}</p>
        <p class="mt-2.5 text-[12px] leading-relaxed text-dim2">{{ t("preview.viewer.cloudOffice.fallbackHint") }}</p>
        <button
          type="button"
          data-testid="cloud-office-retry"
          class="mt-3 cursor-pointer rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="retry()"
        >
          {{ t("preview.viewer.cloudOffice.retry") }}
        </button>
      </div>
    </div>

    <!--
      sandbox 必须带 allow-same-origin：厂商的文档页要在自己的 origin 下带 cookie 运行，
      去掉它页面会以「无权限」告终。这里是**跨源**内容，allow-same-origin 不会让它够到
      本应用的 DOM（那需要同源）。
      referrerpolicy 与全站一致（服务端的 Referrer-Policy: no-referrer 同理）：
      不把自托管的地址与路径泄漏给厂商。
    -->
    <iframe
      v-else-if="url"
      data-testid="cloud-office-frame"
      :src="url"
      class="min-h-0 flex-1 border-0 bg-white"
      :title="props.tab.name"
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
      referrerpolicy="no-referrer"
      allow="fullscreen"
    />
  </div>
</template>
