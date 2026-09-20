<script setup lang="ts">
/**
 * 设置页「运行模式」下的隔离快照回收面板。
 *
 * 运行模式选 worktree 时，宿主每轮派生一份快照（git 仓库是真 worktree，普通目录是整目录
 * 复制）。快照不会自动过期，也没有别的入口能删——不给出这个面板，目录副本就会一直堆积。
 *
 * 只做「列出 + 释放」：把快照合并回工作区的 diff/apply 是另一件事，不在本面板里假装能做。
 */
import { computed, onMounted, ref } from "vue";
import { basename } from "@greywork/core";
import { formatBytes } from "@/lib/attachments";
import { worktreeBackend, type WorktreeEntry } from "@/lib/worktree-backend";
import Hint from "@/features/shared/Hint.vue";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";

const KIND_LABELS: Record<WorktreeEntry["kind"], string> = {
  git: "git worktree",
  copy: "目录副本",
  direct: "未隔离（数据根直通）",
};

const entries = ref<WorktreeEntry[]>([]);
const loading = ref(false);
const error = ref("");
/** 释放目标：单条快照 / 全部。null = 无确认弹层。 */
const confirm = ref<null | { kind: "one"; entry: WorktreeEntry } | { kind: "all" }>(null);
/** 有释放请求在途（禁用按钮防重复点击）。 */
const releasing = ref(false);
/** 单条释放时命中的 root，用于让该行变灰。 */
const releasingRoot = ref<string | null>(null);

const hostAvailable = worktreeBackend.active();
const totalBytes = computed(() => entries.value.reduce((sum, entry) => sum + entry.bytes, 0));

onMounted(() => void refresh());

async function refresh(): Promise<void> {
  if (!worktreeBackend.active()) return; // 浏览器态：列表恒空，不必往返
  loading.value = true;
  error.value = "";
  try {
    entries.value = await worktreeBackend.list();
  } catch (failure) {
    error.value = String(failure);
  } finally {
    loading.value = false;
  }
}

async function performRelease(): Promise<void> {
  const target = confirm.value;
  if (!target) return;
  confirm.value = null;
  error.value = "";
  releasing.value = true;
  try {
    if (target.kind === "one") {
      releasingRoot.value = target.entry.root;
      await worktreeBackend.release(target.entry.root);
      entries.value = entries.value.filter((entry) => entry.root !== target.entry.root);
    } else {
      // 逐个释放：一条失败不该吞掉其余结果，失败的留在列表里让用户看得见。
      const failures: string[] = [];
      for (const entry of [...entries.value]) {
        try {
          await worktreeBackend.release(entry.root);
          entries.value = entries.value.filter((candidate) => candidate.root !== entry.root);
        } catch (failure) {
          failures.push(`${entry.root}: ${String(failure)}`);
        }
      }
      if (failures.length > 0) error.value = `部分快照释放失败：\n${failures.join("\n")}`;
    }
  } catch (failure) {
    error.value = String(failure);
  } finally {
    releasingRoot.value = null;
    releasing.value = false;
  }
}

/** 路径末段作行级 data-testid 后缀（两种分隔符都吃，Windows 快照路径也能定位）。 */
function rootSlug(root: string): string {
  return basename(root) || root;
}
</script>

<template>
  <div class="rounded-[14px] border border-line bg-panel p-4">
    <div class="mb-1 flex items-center justify-between gap-2">
      <span class="text-[13px] font-medium text-foreground">隔离快照</span>
      <span class="flex gap-1.5">
        <button
          type="button"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-foreground disabled:opacity-50"
          :disabled="!hostAvailable || loading"
          @click="refresh"
        >
          {{ loading ? "读取中…" : "刷新" }}
        </button>
        <button
          v-if="entries.length > 0"
          type="button"
          data-testid="worktree-release-all"
          class="h-6 cursor-pointer rounded-[6px] border border-line bg-panel-2 px-2 text-[11px] text-dim transition-colors hover:border-line-2 hover:text-destructive disabled:opacity-50"
          :disabled="!hostAvailable || releasing"
          @click="confirm = { kind: 'all' }"
        >
          全部释放
        </button>
      </span>
    </div>
    <p class="mb-3 text-[11px] leading-relaxed text-dim2">
      运行模式选 Worktree 时，宿主每轮派生一份快照（git 仓库是真 worktree，普通目录是整目录复制）； agent
      的写入落在快照里，不会回到你的工作区。快照不会自动过期，用完在这里释放。
      <template v-if="!hostAvailable">浏览器预览态只读：查看与释放需要桌面版（Tauri）。</template>
    </p>

    <p v-if="error" class="mb-2 whitespace-pre-line text-[11px] text-destructive">{{ error }}</p>

    <p v-if="entries.length === 0" class="text-[12px] text-dim2">
      {{ loading ? "读取中…" : "还没有隔离快照。选 Worktree 跑一轮就会出现。" }}
    </p>
    <div v-else class="flex flex-col gap-2">
      <div
        v-for="entry in entries"
        :key="entry.root"
        data-testid="worktree-row"
        class="rounded-[10px] bg-panel-2 p-2.5"
        :class="releasingRoot === entry.root ? 'opacity-60' : ''"
      >
        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span
                class="shrink-0 rounded-full border border-line px-1.5 py-px text-[10px]"
                :class="entry.kind === 'direct' ? 'text-amber-400' : 'text-dim2'"
              >
                {{ KIND_LABELS[entry.kind] }}
              </span>
              <span class="shrink-0 text-[10px] text-dim2">{{ formatBytes(entry.bytes) }}</span>
            </div>
            <Hint :text="entry.root" multiline>
              <p class="mt-1 truncate font-mono text-[10px] text-dim2">{{ entry.root }}</p>
            </Hint>
            <Hint :text="entry.source" multiline>
              <p class="mt-0.5 truncate font-mono text-[10px] text-dim2">源：{{ entry.source }}</p>
            </Hint>
          </div>
          <button
            type="button"
            :data-testid="`worktree-release-${rootSlug(entry.root)}`"
            class="shrink-0 rounded-[8px] border border-line px-2 py-1 text-[11px] text-dim transition-colors hover:text-destructive disabled:opacity-50"
            :disabled="!hostAvailable || releasing"
            @click="confirm = { kind: 'one', entry }"
          >
            释放
          </button>
        </div>
      </div>
      <p class="text-[10px] leading-relaxed text-dim2">
        共 {{ entries.length }} 份，合计 {{ formatBytes(totalBytes) }}。git 快照的体积只算检出的文件：
        对象库与源仓库共享，仓库历史不计在内。
      </p>
    </div>

    <ConfirmDialog
      v-if="confirm?.kind === 'one'"
      title="释放这份隔离快照？"
      :message="`将删除 ${confirm.entry.root} 整个目录。agent 写在快照里的改动会一并消失，且不可撤销。`"
      confirm-label="释放"
      :busy="releasing"
      @confirm="performRelease"
      @cancel="confirm = null"
    />

    <ConfirmDialog
      v-if="confirm?.kind === 'all'"
      title="释放全部隔离快照？"
      :message="`将删除全部 ${entries.length} 个快照目录，共 ${formatBytes(totalBytes)}。agent 写在快照里的改动会一并消失，且不可撤销。`"
      confirm-label="全部释放"
      :busy="releasing"
      @confirm="performRelease"
      @cancel="confirm = null"
    />
  </div>
</template>
