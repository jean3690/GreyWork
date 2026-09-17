<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import Icon from "@/features/shared/Icon.vue";
import IconPicker from "@/features/shared/IconPicker.vue";
import Hint from "@/features/shared/Hint.vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { pickWorkspaceFolder } from "@/lib/workspace-picker";
import { bindWorkspaceFolder } from "@/lib/workspace-bind";
import type { HistoryGroup } from "@/lib/grouped";

/**
 * 工作区行的管理面板（行尾 ⋯ 点开的动作抽屉）：
 * 存放文件夹、改名、换图标、设默认、换绑文件夹、删除。
 * 所有半途状态（重命名输入框 / 图标选择器 / 删除确认）都归本组件自己的生命周期——
 * 面板关掉即卸载，自然把草稿一并带走（这就是把面板抽出来而不是留在列表根的原因）。
 * 删除与搬迁结果都会冒泡给父组件（删除要动会话归属，必须在列表层做）。
 */
const props = defineProps<{
  group: HistoryGroup;
  /** 当前默认工作区 id：决定「设为默认 / 默认（点击取消）」这一项的读法。 */
  defaultWorkspaceId: string | null;
  /** 该行最近的搬迁结果提示文案（无则不显示）。 */
  relocateNotice: string | null;
}>();

const emit = defineEmits<{
  close: [];
  delete: [id: string];
  relocate: [id: string, result: { moved: number; conflicts: string[] }];
}>();

const workspaceStore = useWorkspaceStore();

const id = computed(() => String(props.group.id));

const folder = computed(() => workspaceStore.workspaceById(props.group.id)?.folder);

/* ===== 重命名工作区（面板内 input：Enter 提交 / Esc 取消 / 失焦提交） ===== */
const renaming = ref(false);
const draftName = ref("");
const renameInput = ref<HTMLInputElement | null>(null);

async function startRename(): Promise<void> {
  renaming.value = true;
  draftName.value = props.group.name;
  await nextTick();
  renameInput.value?.select();
}

function commitRename(): void {
  renaming.value = false;
  if (id.value && draftName.value.trim()) workspaceStore.renameWorkspace(id.value, draftName.value);
}

function cancelRename(): void {
  renaming.value = false;
}

/* ===== 换图标（点选即存，不需要额外确认） ===== */
const iconPickerOpen = ref(false);

function toggleIconPicker(): void {
  iconPickerOpen.value = !iconPickerOpen.value;
}

function pickIcon(icon: string): void {
  workspaceStore.setWorkspaceIcon(id.value, icon || null);
}

function toggleDefault(): void {
  workspaceStore.setDefaultWorkspace(workspaceStore.defaultWorkspaceId === id.value ? null : id.value);
}

/** 换绑文件夹：既有会话文件一并搬到新目录（否则只有新会话按新目录落盘）。 */
async function rebindFolder(): Promise<void> {
  const nextFolder = await pickWorkspaceFolder();
  if (!nextFolder) return;
  const result = await bindWorkspaceFolder(id.value, nextFolder);
  emit("relocate", id.value, result);
}

/* ===== 删除工作区（面板内二次确认，确认后归列表层处理） ===== */
const pendingDelete = ref(false);
const deleteCancelEl = ref<HTMLButtonElement | null>(null);

/** 打开确认即把焦点移进面板（Esc 的接收者）；关闭时焦点还给触发区。 */
async function openDeleteConfirm(): Promise<void> {
  pendingDelete.value = true;
  await nextTick();
  deleteCancelEl.value?.focus();
}

function cancelDelete(): void {
  pendingDelete.value = false;
}

function confirmDelete(): void {
  pendingDelete.value = false;
  emit("delete", id.value);
}
</script>

<template>
  <div
    class="mb-0.5 ml-5 flex shrink-0 flex-col gap-1 rounded-[8px] border border-line-2 bg-panel px-1.5 py-1.5"
    @keydown.esc="emit('close')"
  >
    <Hint :text="folder" multiline>
      <span class="truncate font-mono text-[10px] text-dim2">{{ folder }}</span>
    </Hint>

    <input
      v-if="renaming"
      ref="renameInput"
      v-model="draftName"
      class="h-6 min-w-0 rounded-[6px] border border-cyan/60 bg-panel-2 px-1.5 text-[11.5px] text-foreground outline-none"
      aria-label="工作区名称"
      @keydown.enter="commitRename"
      @keydown.esc.stop="cancelRename"
      @blur="commitRename"
    />
    <div v-else class="flex flex-col gap-0.5">
      <Hint text="重命名工作区（默认取文件夹名）">
        <button
          type="button"
          :data-testid="`workspace-rename-${group.id}`"
          class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="startRename"
        >
          <Icon name="edit" :size="11" class="text-dim2" />
          重命名
        </button>
      </Hint>
      <Hint text="改这个工作区在侧栏显示的图标">
        <button
          type="button"
          :data-testid="`workspace-icon-${group.id}`"
          class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :aria-expanded="iconPickerOpen"
          @click="toggleIconPicker"
        >
          <Icon :name="group.icon ?? 'folder'" :size="11" class="text-dim2" />
          图标
        </button>
      </Hint>
      <div v-if="iconPickerOpen" class="border-t border-line-2 pt-1">
        <IconPicker :model-value="group.icon ?? ''" :columns="6" clearable clear-label="默认" @update:model-value="pickIcon" />
      </div>
      <Hint text="设为默认：下次启动没有上次记录时落在这里">
        <button
          type="button"
          :data-testid="`workspace-default-${group.id}`"
          class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :class="defaultWorkspaceId === group.id ? 'text-cyan' : 'text-dim hover:text-foreground'"
          :aria-pressed="defaultWorkspaceId === group.id"
          @click="toggleDefault"
        >
          <Icon name="pin" :size="11" :class="defaultWorkspaceId === group.id ? '' : 'text-dim2'" />
          {{ defaultWorkspaceId === group.id ? "默认（点击取消）" : "设为默认" }}
        </button>
      </Hint>
      <Hint :text="folder ? '换绑文件夹：既有会话文件一并搬到新目录' : '选择存放文件夹：会话改存到该文件夹'">
        <button
          type="button"
          :data-testid="`workspace-rebind-${group.id}`"
          class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="rebindFolder"
        >
          <Icon name="folder" :size="11" class="text-dim2" />
          {{ folder ? "换绑文件夹" : "绑定文件夹" }}
        </button>
      </Hint>
      <button
        type="button"
        :data-testid="`workspace-delete-${group.id}`"
        class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        :aria-label="`删除工作区 ${group.name}`"
        @click="openDeleteConfirm"
      >
        <Icon name="delete" :size="11" class="text-dim2" />
        删除
      </button>
    </div>

    <div v-if="pendingDelete" class="flex flex-col gap-1 border-t border-line-2 pt-1" @keydown.esc.prevent="cancelDelete">
      <span class="text-[11px] text-dim">删除该工作区？其会话将移入「普通对话」</span>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="h-5 shrink-0 cursor-pointer rounded-[5px] border border-line bg-panel-2 px-1.5 text-[11px] text-foreground transition-colors hover:border-line-2"
          @click="confirmDelete"
        >
          删除
        </button>
        <button
          ref="deleteCancelEl"
          type="button"
          class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[11px] text-dim transition-colors hover:text-foreground"
          @click="cancelDelete"
        >
          取消
        </button>
      </div>
    </div>

    <span v-if="relocateNotice" role="status" class="text-[10.5px] text-cyan">
      {{ relocateNotice }}
    </span>
  </div>
</template>
