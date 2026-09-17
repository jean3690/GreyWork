<script setup lang="ts">
/**
 * 抓取网页对话框：输入 URL → 宿主抓取 + 前端提正文 → 打开网页预览 tab。
 *
 * 入口在预览面板工具条（地球按钮）。浏览器态没有宿主通道，按钮禁用并说明原因。
 */
import { computed, ref } from "vue";
import { fetchArticle, normalizeUrl } from "@/lib/web-fetch";
import { webFetchBackend } from "@/lib/web-fetch-backend";
import { usePreviewStore } from "@/stores/preview";
import { i18n } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const emit = defineEmits<{ close: [] }>();
const t = i18n.global.t;
const preview = usePreviewStore();

const supported = computed(() => webFetchBackend.supported());
const url = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

/**
 * 消费者用 `v-if` 挂载，存在即打开态；关闭由消费者卸载。
 * 用 v-model 而非静态 :open，让关闭能走完整流程（退场动画、焦点归还）——
 * 静态 prop 的话 reka-ui 收不到父级更新，弹层会关不掉。
 */
const open = ref(true);

/** Dialog 收下 Esc / 点遮罩后关闭，这里转成对外的 close。 */
function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}

async function submit(): Promise<void> {
  const normalized = normalizeUrl(url.value);
  if (!normalized || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const article = await fetchArticle(normalized);
    preview.open(article.url, article.title, "web", "web");
    emit("close");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent :show-close-button="false" class="gap-0 rounded-[14px] border-line bg-panel p-4 shadow-xl sm:max-w-[420px]">
      <form @submit.prevent="submit">
        <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("web.title") }}</DialogTitle>
        <DialogDescription class="mt-1.5 text-[11.5px] leading-relaxed text-dim2">
          {{ t("web.description") }}
        </DialogDescription>
        <input
          v-model="url"
          type="text"
          data-testid="web-fetch-url"
          :placeholder="t('web.urlPlaceholder')"
          :disabled="!supported || busy"
          class="mt-3 h-9 w-full rounded-[8px] border border-line-2 bg-panel-2 px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-cyan disabled:opacity-50"
        />
        <p v-if="!supported" class="mt-2 text-[11.5px] text-dim2">{{ t("web.unsupportedRuntime") }}</p>
        <p v-else-if="error" role="alert" class="mt-2 text-[12px] text-orange">{{ t("web.error", { detail: error }) }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
            @click="emit('close')"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            type="submit"
            data-testid="web-fetch-submit"
            :disabled="busy || !supported || !url.trim()"
            class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity disabled:opacity-60"
          >
            {{ busy ? t("web.fetching") : t("web.fetch") }}
          </button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
