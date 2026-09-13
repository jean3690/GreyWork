<script setup lang="ts">
/**
 * 网页正文预览：显示抓取并提取后的纯文本，并提供「发送到对话」。
 *
 * 只渲染纯文本 —— 远端 HTML 永不进 DOM、更不执行：这里既不用 v-html，也不用 iframe，
 * 正文的所有标签已在提取阶段被剥掉，避免把不可信页面当成可执行内容渲染。
 */
import { ref, watch } from "vue";
import { fetchArticle, getCachedArticle, type WebArticle } from "../../lib/web-fetch";
import { appEvents } from "../../events";
import { i18n } from "../../i18n";
import { notify } from "../../stores/notice";
import type { PreviewTab } from "../../stores/preview";
import Icon from "../Icon.vue";

const props = defineProps<{ tab: PreviewTab }>();
const t = i18n.global.t;

const article = ref<WebArticle | null>(getCachedArticle(props.tab.path) ?? null);
const loading = ref(false);
const error = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    article.value = await fetchArticle(props.tab.path);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

// 缓存命中则直接显示；否则（首次或空缓存）抓取。reload 按钮自增 revision → 重新抓。
if (!article.value) void load();
watch(
  () => props.tab.revision,
  () => void load(),
);

function sendToChat(): void {
  const current = article.value;
  if (!current) return;
  appEvents.emit("chat:attachText", { name: current.title, text: current.text, mime: "text/markdown" });
  notify({ kind: "success", key: "web-send-to-chat", title: t("web.sendToChatDone") });
}
</script>

<template>
  <div class="flex size-full min-h-0 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
      <span class="grid size-6 shrink-0 place-items-center rounded-[6px] bg-panel-2 text-dim">
        <Icon name="earth" :size="13" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[12.5px] font-medium text-foreground">{{ article?.title || t("web.title") }}</div>
        <div class="truncate text-[11px] text-dim2" :title="article?.finalUrl ?? props.tab.path">
          {{ article?.finalUrl ?? props.tab.path }}
        </div>
      </div>
      <button
        type="button"
        data-testid="web-send-to-chat"
        :disabled="!article"
        class="flex shrink-0 cursor-pointer items-center gap-1 rounded-[7px] border border-line-2 bg-panel-2 px-2 py-1 text-[11.5px] text-foreground transition-colors hover:border-cyan hover:text-cyan disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        @click="sendToChat"
      >
        <Icon name="send-one" :size="12" />
        {{ t("web.sendToChat") }}
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
      <p v-if="loading" class="text-[12px] text-dim2">{{ t("web.fetching") }}</p>
      <p v-else-if="error" role="alert" class="text-[12px] text-orange">{{ t("web.error", { detail: error }) }}</p>
      <p v-else-if="!article?.text" class="text-[12px] text-dim2">{{ t("web.empty") }}</p>
      <pre v-else class="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground">{{ article.text }}</pre>
    </div>
  </div>
</template>
