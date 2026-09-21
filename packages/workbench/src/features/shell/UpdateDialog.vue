<script setup lang="ts">
/**
 * 检查更新对话框：打开即查 GitHub 最新 Release，展示新版发布说明（改了什么）。
 *
 * - manual（桌面端）：「前往下载」用系统浏览器打开发布页手动装（应用不内置原地升级）。
 * - unsupported（浏览器态）：提示需要桌面版。
 *
 * 消费者用 `v-if` 挂载，存在即打开态；关闭由消费者卸载（与本目录其它弹窗一致）。
 */
import { onMounted, ref } from "vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { i18n } from "@/i18n";
import { updateBackend, type UpdateStatus } from "@/lib/update-backend";

const emit = defineEmits<{ close: [] }>();
const t = i18n.global.t;

/** checking→查询中；ready→已比对；error→失败。 */
type Phase = "checking" | "ready" | "error";

const phase = ref<Phase>("checking");
const status = ref<UpdateStatus | null>(null);
const errorDetail = ref("");
const busy = ref(false);

const open = ref(true);

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}

async function runCheck(): Promise<void> {
  phase.value = "checking";
  try {
    status.value = await updateBackend.check();
    phase.value = "ready";
  } catch (cause) {
    errorDetail.value = cause instanceof Error ? cause.message : String(cause);
    phase.value = "error";
  }
}

/** 打开发布页手动下载。 */
async function download(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await updateBackend.openExternal(status.value?.url ?? "");
    emit("close");
  } finally {
    busy.value = false;
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
      <DialogDescription
        v-else-if="phase === 'error'"
        class="mt-2 text-[12px] leading-relaxed text-orange"
        role="alert"
        data-testid="update-error"
      >
        {{ t("update.failed", { detail: errorDetail }) }}
      </DialogDescription>

      <!-- 已比对：unsupported / 有更新 / 已最新 -->
      <template v-else-if="status">
        <DialogDescription
          v-if="status.mode === 'unsupported'"
          class="mt-2 text-[12px] leading-relaxed text-dim2"
          data-testid="update-unsupported"
        >
          {{ t("update.unsupported") }}
        </DialogDescription>

        <template v-else>
          <DialogDescription class="mt-2 flex items-center gap-2 text-[12px] text-dim2">
            <span>{{ t("update.current", { version: status.currentVersion ?? "—" }) }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ t("update.latest", { version: status.version ?? "—" }) }}</span>
          </DialogDescription>

          <p
            v-if="status.hasUpdate"
            class="mt-2 inline-flex w-fit items-center rounded-[6px] bg-accent/15 px-2 py-0.5 text-[11.5px] font-medium text-accent"
            data-testid="update-available"
          >
            {{ t("update.available") }}
          </p>
          <p v-else class="mt-2 text-[12px] text-dim2" data-testid="update-uptodate">{{ t("update.upToDate") }}</p>

          <!-- 发布说明：新版本改了什么 -->
          <template v-if="status.hasUpdate">
            <div class="mt-3 text-[12px] font-medium text-foreground">
              {{ t("update.latest", { version: status.version ?? "—" }) }}
              <span v-if="status.date" class="ml-1 text-[11px] font-normal text-dim2">{{ status.date }}</span>
            </div>
            <pre
              v-if="status.notes.trim()"
              class="mt-1.5 max-h-[300px] overflow-y-auto rounded-[8px] border border-line-2 bg-panel-2 p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap text-dim"
              data-testid="update-notes"
              >{{ status.notes.trim() }}</pre
            >
            <p v-else class="mt-1.5 text-[12px] text-dim2">{{ t("update.notesEmpty") }}</p>
          </template>
        </template>
      </template>

      <div class="mt-4 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-[8px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] text-dim transition-colors hover:text-foreground"
          @click="emit('close')"
        >
          {{ phase === "ready" && status?.hasUpdate ? t("update.later") : t("update.close") }}
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

        <!-- manual 通道：打开发布页 -->
        <button
          v-else-if="phase === 'ready' && status?.hasUpdate && status.mode === 'manual'"
          type="button"
          data-testid="update-download"
          :disabled="busy"
          class="rounded-[8px] bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-opacity hover:bg-accent disabled:opacity-60"
          @click="download"
        >
          {{ t("update.download") }}
        </button>
      </div>
    </DialogContent>
  </Dialog>
</template>
