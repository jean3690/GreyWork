<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useSessionStore } from "../stores/session";
import { useWorkspaceStore } from "../stores/workspace";
import { groupSessions, type HistoryGroup } from "../lib/grouped";
import { pickWorkspaceFolder } from "../lib/workspace-picker";
import { bindWorkspaceFolder } from "../lib/workspace-bind";
import Icon from "./Icon.vue";
import GroupedHistorySessions from "./GroupedHistorySessions.vue";

/**
 * GreyWork 风格会话历史：工作区列表（一行一个，可展开/收起）+ 展开后的会话。
 *
 * 行本身就是切换器：点击 = 切成当前工作区（新会话、产物落盘、agent 配置记忆都跟着它走）。
 * caret 只管展开/收起会话；行尾 + 在该工作区直接开新会话；⋯ 点开才铺管理面板（存放路径 + 重命名 /
 * 设为默认 / 换绑文件夹 / 删除），一次只开一个，关掉时半途的重命名与删除确认一并撤回。
 * 未绑定工作区的会话落在末行「普通对话」（合并规则见 grouped.ts）。
 * 搜索时只留有命中的组并强制展开——此刻列表是结果面。
 * 行高 34px、圆角 8px；分组逻辑在 grouped.ts（纯函数，单测覆盖）。
 * 展开体里的会话列表在 GroupedHistorySessions：会话多到阈值就切虚拟窗口，详见该文件。
 */
const props = defineProps<{
  activeSessionId: string | null;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const query = ref("");

/** 行序取工作区声明顺序（刻意不按最近使用排）：切换工作区时行不会在脚下跳位。 */
const groups = computed<HistoryGroup[]>(() =>
  groupSessions({
    workspaces: workspaceStore.workspaces,
    sessions: sessionStore.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      workspaceId: session.workspaceId,
    })),
    keyword: query.value,
  }),
);

/** 搜索态：折叠让位于命中（强制展开，收起按钮同步禁用）。 */
const filtering = computed(() => query.value.trim().length > 0);

/** DOM key / testid / aria-controls 用的稳定行标识（兜底行的 id 可能是 null）。 */
function rowKey(group: HistoryGroup): string {
  return group.id ?? "general";
}

/**
 * 该行是否为当前工作区。
 * 兜底行额外认领 activeWorkspaceId === null：旧数据里「未绑定」就是 null，而这一行正是它的落点
 * （有 p-general 时 group.id 即 p-general，两者对落盘的含义相同——没有存放文件夹）。
 */
function isActiveRow(group: HistoryGroup): boolean {
  const active = workspaceStore.activeWorkspaceId;
  return active === group.id || (active === null && group.general);
}

/** 展开态；默认只展开当前工作区那行。key 为组 id（兜底行可能是 null）。 */
const expandedIds = ref<Set<string | null>>(new Set(groups.value.filter(isActiveRow).map((group) => group.id)));

function isExpanded(group: HistoryGroup): boolean {
  return filtering.value || expandedIds.value.has(group.id);
}

function toggleExpand(group: HistoryGroup): void {
  const next = new Set(expandedIds.value);
  if (next.has(group.id)) next.delete(group.id);
  else next.add(group.id);
  expandedIds.value = next;
}

function expand(id: string | null): void {
  if (expandedIds.value.has(id)) return;
  expandedIds.value = new Set(expandedIds.value).add(id);
}

/** 行点击：切成当前工作区并展开；已经是当前工作区就退化成展开/收起。 */
function selectRow(group: HistoryGroup): void {
  if (isActiveRow(group)) {
    toggleExpand(group);
    return;
  }
  workspaceStore.setActiveWorkspace(group.id);
  expand(group.id);
}

/**
 * 在该工作区里开新会话：顺带切成当前工作区（新会话的 agent 配置 / 产物落盘都按当前工作区走，
 * 不对齐就会「会话属于 A、产物落到 B」）、展开该行，并清掉搜索——否则「新对话」不匹配关键字，
 * 刚建的会话会被过滤掉看不见。
 */
function newSessionIn(group: HistoryGroup): void {
  workspaceStore.setActiveWorkspace(group.id);
  expand(group.id);
  query.value = "";
  const session = sessionStore.createSession(group.id);
  emit("navigate", `/conversation/${session.id}`);
}

function folderOf(group: HistoryGroup): string | undefined {
  return workspaceStore.workspaceById(group.id)?.folder;
}

const UNBOUND_HINT = "未绑定文件夹：会话存 ~/.greyWork/sessions";

function rowHint(group: HistoryGroup): string {
  const folder = folderOf(group);
  return folder ? `会话存 ${folder}/.greyWork/sessions` : UNBOUND_HINT;
}

function folderName(folder: string): string {
  return folder.split(/[/\\]/).filter(Boolean).pop() ?? folder;
}

/** 搬迁结果提示（换文件夹后告诉用户历史会话去哪了）；就地挂在对应工作区行下。 */
const relocateNotice = ref<{ id: string; text: string } | null>(null);

function reportRelocation(id: string, result: { moved: number; conflicts: string[] }): void {
  if (result.conflicts.length) {
    relocateNotice.value = {
      id,
      text: `已搬迁 ${result.moved} 条会话；${result.conflicts.length} 条在新目录已有更新版本，两边都保留`,
    };
    return;
  }
  relocateNotice.value = result.moved ? { id, text: `已搬迁 ${result.moved} 条会话到新文件夹` } : null;
}

async function addWorkspace(): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;
  // createWorkspace 已把新工作区设为当前；顺手展开——刚添加就想看见它
  const workspace = workspaceStore.createWorkspace(folderName(folder), "用户自定义工作区");
  expand(workspace.id);
  reportRelocation(workspace.id, await bindWorkspaceFolder(workspace.id, folder));
}

/** 换绑文件夹：既有会话文件一并搬到新目录（否则只有新会话按新目录落盘）。 */
async function rebindFolder(id: string): Promise<void> {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;
  relocateNotice.value = null;
  reportRelocation(id, await bindWorkspaceFolder(id, folder));
}

function toggleDefault(id: string): void {
  workspaceStore.setDefaultWorkspace(workspaceStore.defaultWorkspaceId === id ? null : id);
}

/* ===== 工作区重命名（名字默认取文件夹名，可改） ===== */
const renamingWorkspaceId = ref<string | null>(null);
const draftWorkspaceName = ref("");
const workspaceRenameInput = ref<HTMLInputElement | null>(null);

function bindWorkspaceRenameInput(el: unknown): void {
  workspaceRenameInput.value = (el as HTMLInputElement | null) ?? null;
}

async function startWorkspaceRename(id: string, name: string): Promise<void> {
  renamingWorkspaceId.value = id;
  draftWorkspaceName.value = name;
  await nextTick();
  workspaceRenameInput.value?.select();
}

function commitWorkspaceRename(): void {
  const id = renamingWorkspaceId.value;
  renamingWorkspaceId.value = null;
  if (id && draftWorkspaceName.value.trim()) workspaceStore.renameWorkspace(id, draftWorkspaceName.value);
}

/* ===== 行内管理：删除工作区（会话重命名/删除在 GroupedHistoryRow 内自洽） ===== */
const pendingDeleteWorkspaceId = ref<string | null>(null);
const workspaceDeleteCancelEl = ref<HTMLButtonElement | null>(null);

/** 打开删除确认并把焦点移进面板（Esc 在面板上收）；关闭时焦点还给触发区。 */
async function openWorkspaceDelete(id: string): Promise<void> {
  pendingDeleteWorkspaceId.value = id;
  await nextTick();
  workspaceDeleteCancelEl.value?.focus();
}

function cancelWorkspaceDelete(): void {
  pendingDeleteWorkspaceId.value = null;
}

/** 展开管理面板的工作区（一次只开一个）；关掉时把重命名 / 删除确认的半途状态一并撤回。 */
const openMenuId = ref<string | null>(null);

function toggleMenu(id: string): void {
  openMenuId.value = openMenuId.value === id ? null : id;
  if (openMenuId.value === null) {
    renamingWorkspaceId.value = null;
    pendingDeleteWorkspaceId.value = null;
  }
}

/** 删除工作区：其会话先迁回「普通对话」，再移除工作区本身。 */
function confirmDeleteWorkspace(id: string): void {
  pendingDeleteWorkspaceId.value = null;
  openMenuId.value = null;
  sessionStore.reassignWorkspace(id, null);
  workspaceStore.deleteWorkspace(id);
  // 会话离开被删工作区；若正打开着其中一条，留在原地会找不到分组——回 Guid 兜底
  const active = props.activeSessionId;
  if (active && sessionStore.getSession(active)?.workspaceId === id) emit("navigate", "/guid");
}

/** 会话列表的外层滚动容器：GroupedHistorySessions 的大列表窗口跟随它。 */
const scrollEl = ref<HTMLElement | null>(null);
/**
 * 模板 ref 在子树挂载后才赋值，而子组件拿到的是渲染期的 prop（恒 null）。
 * 挂载后踢一脚让父组件重渲一次，子组件的 scrollElement / tick 才拿到真元素。
 */
const scrollTick = ref(0);
onMounted(() => {
  scrollTick.value += 1;
});
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2">
    <div class="flex items-center gap-1 px-1 pt-1">
      <span class="text-[10.5px] font-medium tracking-wide text-dim2 uppercase">工作区</span>
      <button
        type="button"
        class="ml-auto grid size-5 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        aria-label="添加工作区"
        title="选择文件夹作为工作区"
        @click="addWorkspace"
      >
        <Icon name="plus" :size="13" />
      </button>
    </div>

    <label class="flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] border border-line-2 bg-panel px-2">
      <Icon name="search" :size="13" class="text-dim2" />
      <input
        v-model="query"
        class="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-dim2"
        placeholder="搜索会话"
        aria-label="搜索会话"
      />
      <button
        v-if="query"
        class="grid size-4 cursor-pointer place-items-center text-dim2 hover:text-foreground"
        aria-label="清空搜索"
        @click="query = ''"
      >
        <Icon name="close" :size="12" />
      </button>
    </label>

    <div ref="scrollEl" class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
      <template v-for="group in groups" :key="rowKey(group)">
        <!-- 工作区行：caret 只管展开，行体管切换（两个独立按钮，避免按钮套按钮） -->
        <div
          class="group/ws flex h-[34px] shrink-0 items-center gap-1 rounded-[8px] pr-1.5 transition-colors"
          :class="isActiveRow(group) ? 'bg-cyan/10' : 'hover:bg-panel'"
        >
          <button
            type="button"
            :data-testid="`workspace-toggle-${rowKey(group)}`"
            class="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan disabled:cursor-default disabled:opacity-40"
            :disabled="filtering"
            :aria-expanded="isExpanded(group)"
            :aria-controls="`workspace-group-${rowKey(group)}`"
            :aria-label="`${isExpanded(group) ? '收起' : '展开'} ${group.name}`"
            :title="filtering ? '搜索中：命中会话已全部展开' : isExpanded(group) ? '收起' : '展开'"
            @click="toggleExpand(group)"
          >
            <Icon name="down" :size="10" class="transition-transform duration-150" :class="isExpanded(group) ? '' : '-rotate-90'" />
          </button>
          <button
            type="button"
            :data-testid="`workspace-row-${rowKey(group)}`"
            class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :class="isActiveRow(group) ? 'text-foreground' : 'text-dim hover:text-foreground'"
            :aria-current="isActiveRow(group) ? 'true' : undefined"
            :title="rowHint(group)"
            @click="selectRow(group)"
          >
            <Icon
              :name="group.general ? 'message' : 'folder'"
              :size="12"
              class="shrink-0"
              :class="isActiveRow(group) ? 'text-cyan' : 'text-dim2'"
            />
            <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">{{ group.name }}</span>
            <Icon v-if="workspaceStore.defaultWorkspaceId === group.id" name="pin" :size="10" class="shrink-0 text-cyan" />
            <span class="shrink-0 text-[10px] text-dim2 tabular-nums">{{ group.sessions.length }}</span>
          </button>
          <!-- 行内动作：hover / 聚焦才浮出（与会话行的重命名/删除同一列） -->
          <button
            type="button"
            :data-testid="`workspace-new-${rowKey(group)}`"
            class="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 opacity-0 transition-opacity group-hover/ws:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :aria-label="`在 ${group.name} 新建会话`"
            :title="`在「${group.name}」新建会话`"
            @click="newSessionIn(group)"
          >
            <Icon name="plus" :size="12" />
          </button>
          <!-- 工作区设置：点开才铺管理动作 -->
          <button
            v-if="!group.general"
            type="button"
            :data-testid="`workspace-menu-${rowKey(group)}`"
            class="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] text-dim2 opacity-0 transition-opacity group-hover/ws:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
            :class="openMenuId === group.id ? 'text-foreground opacity-100' : ''"
            :aria-expanded="openMenuId === group.id"
            :aria-label="`${group.name} 的工作区设置`"
            title="工作区设置：重命名 / 设为默认 / 文件夹 / 删除"
            @click="toggleMenu(String(group.id))"
            @keydown.esc="openMenuId = null"
          >
            <Icon name="more" :size="12" />
          </button>
          <!-- 兜底行没有设置项，用等宽占位保住右侧计数列对齐 -->
          <span v-else class="size-5 shrink-0" aria-hidden="true" />
        </div>

        <!-- 管理面板：行尾 ⋯ 点开才显示，平时不占视觉 -->
        <div
          v-if="!group.general && openMenuId === group.id"
          class="mb-0.5 ml-5 flex shrink-0 flex-col gap-1 rounded-[8px] border border-line-2 bg-panel px-1.5 py-1.5"
          @keydown.esc="openMenuId = null"
        >
          <span v-if="folderOf(group)" class="truncate font-mono text-[10px] text-dim2" :title="folderOf(group)">
            {{ folderOf(group) }}
          </span>

          <input
            v-if="renamingWorkspaceId === group.id"
            :ref="bindWorkspaceRenameInput"
            v-model="draftWorkspaceName"
            class="h-6 min-w-0 rounded-[6px] border border-cyan/60 bg-panel-2 px-1.5 text-[11.5px] text-foreground outline-none"
            aria-label="工作区名称"
            @keydown.enter="commitWorkspaceRename"
            @keydown.esc.stop="renamingWorkspaceId = null"
            @blur="commitWorkspaceRename"
          />
          <div v-else class="flex flex-col gap-0.5">
            <button
              type="button"
              :data-testid="`workspace-rename-${group.id}`"
              class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              title="重命名工作区（默认取文件夹名）"
              @click="startWorkspaceRename(String(group.id), group.name)"
            >
              <Icon name="edit" :size="11" class="text-dim2" />
              重命名
            </button>
            <button
              type="button"
              :data-testid="`workspace-default-${group.id}`"
              class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] transition-colors hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :class="workspaceStore.defaultWorkspaceId === group.id ? 'text-cyan' : 'text-dim hover:text-foreground'"
              :aria-pressed="workspaceStore.defaultWorkspaceId === group.id"
              title="设为默认：下次启动没有上次记录时落在这里"
              @click="toggleDefault(String(group.id))"
            >
              <Icon name="pin" :size="11" :class="workspaceStore.defaultWorkspaceId === group.id ? '' : 'text-dim2'" />
              {{ workspaceStore.defaultWorkspaceId === group.id ? "默认（点击取消）" : "设为默认" }}
            </button>
            <button
              type="button"
              :data-testid="`workspace-rebind-${group.id}`"
              class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :title="folderOf(group) ? '换绑文件夹：既有会话文件一并搬到新目录' : '选择存放文件夹：会话改存到该文件夹'"
              @click="rebindFolder(String(group.id))"
            >
              <Icon name="folder" :size="11" class="text-dim2" />
              {{ folderOf(group) ? "换绑文件夹" : "绑定文件夹" }}
            </button>
            <button
              type="button"
              :data-testid="`workspace-delete-${group.id}`"
              class="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :aria-label="`删除工作区 ${group.name}`"
              @click="openWorkspaceDelete(String(group.id))"
            >
              <Icon name="delete" :size="11" class="text-dim2" />
              删除
            </button>
          </div>

          <div
            v-if="pendingDeleteWorkspaceId === group.id"
            class="flex flex-col gap-1 border-t border-line-2 pt-1"
            @keydown.esc.prevent="cancelWorkspaceDelete"
          >
            <span class="text-[11px] text-dim">删除该工作区？其会话将移入「普通对话」</span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="h-5 shrink-0 cursor-pointer rounded-[5px] border border-line bg-panel-2 px-1.5 text-[11px] text-foreground transition-colors hover:border-line-2"
                @click="confirmDeleteWorkspace(String(group.id))"
              >
                删除
              </button>
              <button
                ref="workspaceDeleteCancelEl"
                type="button"
                class="h-5 shrink-0 cursor-pointer rounded-[5px] px-1.5 text-[11px] text-dim transition-colors hover:text-foreground"
                @click="cancelWorkspaceDelete"
              >
                取消
              </button>
            </div>
          </div>

          <span v-if="relocateNotice?.id === group.id" role="status" class="text-[10.5px] text-cyan">
            {{ relocateNotice.text }}
          </span>
        </div>

        <!-- 展开体：该工作区的会话（数量大时内部自动切虚拟窗口） -->
        <div
          v-if="isExpanded(group)"
          :id="`workspace-group-${rowKey(group)}`"
          role="group"
          :aria-label="`${group.name} 的会话`"
          class="flex flex-col pl-5"
        >
          <GroupedHistorySessions
            :sessions="group.sessions"
            :active-session-id="props.activeSessionId"
            :scroll-element="scrollEl"
            :scroll-tick="scrollTick"
            @navigate="emit('navigate', $event)"
          />
        </div>
      </template>

      <p v-if="!groups.length" class="px-2 pt-8 text-center text-[12px] text-dim2">没有匹配的会话</p>
    </div>
  </div>
</template>
