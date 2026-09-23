<script setup lang="ts">
/**
 * 「新建文件 / 文件夹」对话框：输入名字交给 store 落盘。
 *
 * **为什么用弹窗而不是在树里插一行草稿节点**：树是 26px 定高虚拟列表，草稿节点得先
 * 进 `FileTreeNode` 树才会被 `flatten()` 产出、并进虚拟 count（见 FileTree.vue），
 * 为一次新建把虚拟化的数据模型改成「含 UI 草稿」不划算。重命名不同 —— 行已经在那儿了，
 * 整行换成 input 即可。
 */
import { computed, nextTick, onMounted, ref } from "vue";
import { useFileTreeStore } from "@/stores/fileTree";
import { nameProblem } from "@/lib/file-name";
import { i18n } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

const props = defineProps<{ dir: string; kind: "file" | "directory" }>();
const emit = defineEmits<{ close: []; created: [] }>();

const t = i18n.global.t;
const tree = useFileTreeStore();

const name = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

/** 消费者用 `v-if` 挂载，存在即打开态（与 WebFetchDialog 同一约定）。 */
const open = ref(true);

const problem = computed(() => nameProblem(name.value));
const canSubmit = computed(() => problem.value === null && !busy.value);

/** 名字问题提示；还没输入时不提示（别一打开就报错）。 */
const hint = computed(() => {
  if (!name.value.trim() || problem.value === null) return null;
  return t(`preview.fileTree.nameProblem.${problem.value}`);
});

function onOpenChange(next: boolean): void {
  if (!next) emit("close");
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = null;
  try {
    // 提交 trim 后的名字：校验就是按 trim 后判的，宿主那边也会再兜一次。
    await tree.createEntry(props.dir, name.value.trim(), props.kind);
    emit("created");
    emit("close");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void nextTick(() => input.value?.focus()));
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent :show-close-button="false" class="gap-0 rounded-[14px] border-line bg-panel p-4 shadow-xl sm:max-w-[380px]">
      <form @submit.prevent="submit">
        <DialogTitle class="text-[13px] font-medium text-foreground">
          {{ kind === "file" ? t("preview.fileTree.newFile") : t("preview.fileTree.newFolder") }}
        </DialogTitle>
        <DialogDescription class="mt-1.5 truncate font-mono text-[11px] leading-relaxed text-dim2" :title="dir">
          {{ dir }}
        </DialogDescription>
        <input
          ref="input"
          v-model="name"
          type="text"
          data-testid="new-entry-name"
          :placeholder="kind === 'file' ? t('preview.fileTree.filePlaceholder') : t('preview.fileTree.folderPlaceholder')"
          :disabled="busy"
          class="mt-3 h-9 w-full rounded-[8px] border border-line-2 bg-panel-2 px-2.5 text-[12.5px] text-foreground outline-none focus-visible:border-cyan disabled:opacity-50"
        />
        <p v-if="hint" class="mt-2 text-[11.5px] text-orange">{{ hint }}</p>
        <p v-else-if="error" role="alert" class="mt-2 text-[12px] text-orange">{{ error }}</p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="new-entry-cancel"
            class="h-8 cursor-pointer rounded-[8px] border border-line bg-panel-2 px-3 text-[12px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            @click="emit('close')"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            type="submit"
            data-testid="new-entry-submit"
            :disabled="!canSubmit"
            class="h-8 cursor-pointer rounded-[8px] bg-accent px-3 text-[12px] font-medium text-accent-ink transition-opacity hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {{ t("common.confirm") }}
          </button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
