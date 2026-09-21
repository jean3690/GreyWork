<script setup lang="ts">
/**
 * 检查更新对话框：打开即查 GitHub 最新 Release，与当前版本比对后给出
 * 「已是最新 / 有新版本」，并展示发布说明（新版本改了什么）。有更新时「前往下载」
 * 用系统浏览器打开发布页 —— 应用没有内置 updater，更新即手动下载安装。
 *
 * 消费者用 `v-if` 挂载，存在即打开态；关闭由消费者卸载（与本目录其它弹窗一致）。
 */
import { onMounted, ref } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { i18n } from "@/i18n";
import { updateBackend, isNewerVersion, REPO_URL, type LatestRelease } from "@/lib/update-backend";

const emit = defineEmits<{ close: [] }>();
const t = i18n.global.t;

/** checking → 查询中；latest → 已比对（release + newer 决定「有更新/已最新」）；error → 失败。 */
type Phase = "checking" | "latest" | "error";

const phase = ref<Phase>("checking");
const current = ref<string | null>(null);
const release = ref<LatestRelease | null>(null);
const newer = ref(false);
/** 错误分档：unsupported = 浏览器态没有宿主通道；failed = 网络/接口失败（带 detail）。 */
const errorKind = ref<"unsupported" | "failed">("failed");
const errorDetail = ref("");
const opening = ref(false);

const open = ref(true);

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}

async function runCheck(): Promise<void> {
  phase.value = "checking";
  try {
    current.value = await updateBackend.currentVersion();
    const latest = await updateBackend.checkUpdate();
    release.value = latest;
    newer.value = current.value ? isNewerVersion(latest.version, current.value) : true;
    phase.value = "latest";
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    errorKind.value = message === "browser-unsupported" ? "unsupported" : "failed";
    errorDetail.value = message;
    phase.value = "error";
  }
}

async function goDownload(): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  try {
    await updateBackend.openExternal(release.value?.url ?? `${REPO_URL}/releases`);
    emit("close");
  } finally {
    opening.value = false;
  }
}

onMounted(runCheck);
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="true"
      class="gap-0 rounded-[14px] border-line bg-panel p-4 shadow-xl sm:max-w-[440px]"
      data-testid="update-dialog"
    >
      <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("update.title") }}</DialogTitle>

      <!-- 查询中 -->
      <DialogDescription v-if="phase === 'checking'" class="mt-2 text-[12px] leading-relaxed text-dim2" data-testid="update-checking">
        {{ t("update.checking") }}
      </DialogDescription>

      <!-- 失败 -->
      <template v-else-if="phase === 'error'">
        <DialogDescription class="mt-2 text-[12px] leading-relaxed text-orange" role="alert" data-testid="update-error">
          {{ errorKind === "unsupported" ? t("update.unsupported") : t("update.failed", { detail: errorDetail }) }}
        </DialogDescription>
      </template>

      <!-- 已比对：有更新 / 已最新 -->
      <template v-else>
        <DialogDescription class="mt-2 flex items-center gap-2 text-[12px] text-dim2">
          <span>{{ t("update.current", { version: current ?? "—" }) }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ t("update.latest", { version: release?.version ?? "—" }) }}</span>
        </DialogDescription>

        <p
          v-if="newer"
          class="mt-2 inline-flex w-fit items-center rounded-[6px] bg-accent/15 px-2 py-0.5 text-[11.5px] font-medium text-accent"
          data-testid="update-available"
        >
          {{ t("update.available") }}
        </p>
        <p v-else class="mt-2 text-[12px] text-dim2" data-testid="update-uptodate">{{ t("update.upToDate") }}</p>

        <!-- 发布说明：新版本改了什么 -->
        <template v-if="newer && release">
          <div class="mt-3 text-[12px] font-medium text-foreground">
            {{ release.name }}
            <span v-if="release.publishedAt" class="ml-1 text-[11px] font-normal text-dim2">
              {{ release.publishedAt.slice(0, 10) }}
            </span>
          </div>
          <pre
            v-if="release.notes.trim()"
            class="mt-1.5 max-h-[300px] overflow-y-auto rounded-[8px] border border-line-2 bg-panel-2 p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-dim"
            data-testid="update-notes"
            >{{ release.notes.trim() }}</pre
          >
          <p v-else class="mt-1.5 text-[12px] text-dim2">{{ t("update.notesEmpty") }}</p>
        </template>
      </template>

      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="emit('close')"
        >
          {{ phase === "latest" && newer ? t("update.later") : t("update.close") }}
        </button>
        <button
          v-if="phase === 'error'"
          type="button"
          data-testid="update-retry"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:bg-accent"
          @click="runCheck"
        >
          {{ t("update.retry") }}
        </button>
        <button
          v-else-if="phase === 'latest' && newer"
          type="button"
          data-testid="update-download"
          :disabled="opening"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:bg-accent disabled:opacity-60"
          @click="goDownload"
        >
          {{ t("update.download") }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
