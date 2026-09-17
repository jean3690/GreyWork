<script setup lang="ts">
/**
 * 标题栏搜索面板：会话（标题 + 正文）与功能入口（侧栏导航 / 设置分区）一起搜，
 * 并可按类型 / 会话状态 / 工作区收窄。
 *
 * 浮层与定位走 shadcn Popover：`<Popover>` 由 Titlebar 持有（触发器是那颗搜索按钮），
 * 本组件只出 `PopoverContent`。原先那套 `Teleport to=body` + 锚点实测坐标 + 夹进视口 +
 * 自挂 window pointerdown/keydown 全部删掉 ——
 * 层级（标题栏是 `relative z-30`，自成层叠上下文）、上下翻转与左右夹紧、Esc、
 * 点击外部关闭都由 reka 负责，视口高度也由 `--reka-popover-content-available-height` 兜住。
 * 选中结果后仍由本组件 `emit("close")` 请父级收起。
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { appEvents } from "@/events";
import { useCapabilityLoader } from "@/plugins/current";
import { useSessionStore } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { buildNavItems } from "@/lib/nav-items";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useSessionStatus, type SessionStatus } from "@/lib/session-status";
import { buildSearchItems, searchItems, type SearchItem, type SearchKind, type SearchType } from "@/lib/search";
import { PopoverContent } from "@/components/ui/popover";
import Icon from "@/features/shared/Icon.vue";
import SessionStatusIndicator from "@/features/shared/SessionStatusIndicator.vue";

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const router = useRouter();
const sessionStore = useSessionStore();
const workspaceStore = useWorkspaceStore();
const statusOf = useSessionStatus();

/* ===== 索引与检索 ===== */
const query = ref("");
const typeFilter = ref<SearchType | null>(null);
const statusFilter = ref<SessionStatus | null>(null);
/** undefined = 不过滤；null = 只看未绑定工作区（普通对话）。 */
const workspaceFilter = ref<string | null | undefined>(undefined);

const STATUSES: readonly SessionStatus[] = ["idle", "running", "waiting", "done"];

const index = computed<SearchItem[]>(() =>
  buildSearchItems({
    sessions: sessionStore.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      workspaceId: session.workspaceId,
      messages: session.messages,
    })),
    navItems: buildNavItems(useCapabilityLoader().snapshot().modes),
    settingsSections: SETTINGS_SECTIONS.map((section) => ({
      key: section.key,
      title: t(`settings.sections.${section.key}.title`),
      description: t(`settings.sections.${section.key}.desc`),
    })),
    statusOf,
  }),
);

const results = computed<SearchItem[]>(() =>
  searchItems(index.value, query.value, {
    type: typeFilter.value,
    status: statusFilter.value,
    workspaceId: workspaceFilter.value,
  }),
);

/** 会话专属筛选（状态 / 工作区）只在没选「功能」时才有意义。 */
const sessionFiltersVisible = computed(() => typeFilter.value !== "feature");

const KIND_ORDER: readonly SearchKind[] = ["session", "nav", "settings"];
const KIND_ICON: Record<SearchKind, string> = { session: "message", nav: "magic", settings: "setting" };

/** 分组渲染；键盘导航用同一顺序的扁平表。 */
const groups = computed(() =>
  KIND_ORDER.map((kind) => ({
    kind,
    items: results.value.filter((item) => item.kind === kind),
  })).filter((group) => group.items.length > 0),
);
const flat = computed(() => groups.value.flatMap((group) => group.items));
/** id → 平铺索引：模板按 id 查行（避免每行 4 次 indexOf 线性扫描）。 */
const flatIndexById = computed(() => new Map(flat.value.map((item, index) => [item.id, index])));
const activeIndex = ref(0);
const activeOptionId = computed(() => (flat.value.length ? `search-option-${activeIndex.value}` : undefined));

/* ===== 筛选动作 ===== */
function setType(next: SearchType | null): void {
  typeFilter.value = next;
  if (next === "feature") {
    statusFilter.value = null;
    workspaceFilter.value = undefined;
  }
  resetActive();
}

function setStatus(next: SessionStatus | null): void {
  statusFilter.value = next;
  resetActive();
}

function onWorkspaceChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  workspaceFilter.value = value === "__all__" ? undefined : value === "__none__" ? null : value;
  resetActive();
}

function resetActive(): void {
  activeIndex.value = 0;
}

/** 打开结果：会话 / 导航走路由；设置是模态、非路由，经事件请 Shell 打开指定分区。 */
function select(item: SearchItem | undefined): void {
  if (!item) return;
  if (item.kind === "settings" && item.section) appEvents.emit("settings:open", { section: item.section });
  else if (item.path) void router.push(item.path);
  emit("close");
}

function onInputKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeIndex.value = Math.min(activeIndex.value + 1, Math.max(0, flat.value.length - 1));
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeIndex.value = Math.max(activeIndex.value - 1, 0);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    select(flat.value[activeIndex.value]);
  }
  // Escape 由 Popover 的 DismissableLayer 统一处理（焦点在面板内任意元素都收得到）。
}

const inputEl = ref<HTMLInputElement | null>(null);

/** Popover 打开时默认把焦点给内容容器；这里改交给搜索框，省用户一次 Tab。 */
function focusInput(event: Event): void {
  event.preventDefault();
  inputEl.value?.focus();
}
</script>

<template>
  <PopoverContent
    data-testid="search-panel"
    role="dialog"
    :aria-label="t('search.title')"
    align="start"
    :side-offset="6"
    :collision-padding="8"
    class="flex max-h-(--reka-popover-content-available-height) w-[460px] flex-col overflow-hidden rounded-[12px] border-line-2 p-0 shadow-[0_16px_48px_rgba(0,0,0,0.28)]"
    @open-auto-focus="focusInput"
  >
    <!-- 搜索框 -->
    <label class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      <Icon name="search" :size="14" class="shrink-0 text-dim2" />
      <input
        ref="inputEl"
        v-model="query"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="search-results"
        :aria-expanded="flat.length > 0"
        :aria-activedescendant="activeOptionId"
        :placeholder="t('search.placeholder')"
        :aria-label="t('search.placeholder')"
        class="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-dim2"
        @keydown="onInputKeydown"
      />
      <button
        v-if="query"
        type="button"
        class="grid size-4 shrink-0 cursor-pointer place-items-center text-dim2 hover:text-foreground"
        :aria-label="t('search.clear')"
        @click="query = ''"
      >
        <Icon name="close" :size="12" />
      </button>
    </label>

    <!-- 筛选条：类型 -->
    <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5" data-testid="search-filters">
      <span class="mr-1 text-[10px] tracking-wide text-dim2 uppercase">{{ t("search.filterType") }}</span>
      <button
        v-for="option in [
          { key: null, label: t('search.type.all') },
          { key: 'session', label: t('search.type.session') },
          { key: 'feature', label: t('search.type.feature') },
        ]"
        :key="String(option.key)"
        type="button"
        :data-testid="`search-type-${option.key ?? 'all'}`"
        :aria-pressed="typeFilter === option.key"
        class="h-5 cursor-pointer rounded-full border px-2 text-[10.5px] transition-colors"
        :class="typeFilter === option.key ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-line text-dim hover:text-foreground'"
        @click="setType(option.key as SearchType | null)"
      >
        {{ option.label }}
      </button>
    </div>

    <!-- 筛选条：会话状态 + 工作区（选「功能」时无意义，隐藏） -->
    <div v-if="sessionFiltersVisible" class="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
      <span class="mr-1 text-[10px] tracking-wide text-dim2 uppercase">{{ t("search.filterStatus") }}</span>
      <button
        type="button"
        data-testid="search-status-all"
        :aria-pressed="statusFilter === null"
        class="h-5 cursor-pointer rounded-full border px-2 text-[10.5px] transition-colors"
        :class="statusFilter === null ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-line text-dim hover:text-foreground'"
        @click="setStatus(null)"
      >
        {{ t("search.type.all") }}
      </button>
      <button
        v-for="status in STATUSES"
        :key="status"
        type="button"
        :data-testid="`search-status-${status}`"
        :aria-pressed="statusFilter === status"
        class="h-5 cursor-pointer rounded-full border px-2 text-[10.5px] transition-colors"
        :class="statusFilter === status ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-line text-dim hover:text-foreground'"
        @click="setStatus(status)"
      >
        {{ t(`sessionStatus.${status}`) }}
      </button>

      <label class="ml-auto flex items-center gap-1 text-[10px] text-dim2">
        {{ t("search.filterWorkspace") }}
        <select
          data-testid="search-workspace"
          class="h-5 max-w-[140px] cursor-pointer rounded-[5px] border border-line bg-panel px-1 text-[10.5px] text-foreground outline-none"
          :value="workspaceFilter === undefined ? '__all__' : workspaceFilter === null ? '__none__' : workspaceFilter"
          @change="onWorkspaceChange"
        >
          <option value="__all__">{{ t("search.workspaceAll") }}</option>
          <option value="__none__">{{ t("search.workspaceGeneral") }}</option>
          <option v-for="workspace in workspaceStore.workspaces" :key="workspace.id" :value="workspace.id">
            {{ workspace.name }}
          </option>
        </select>
      </label>
    </div>

    <!-- 结果 -->
    <div id="search-results" role="listbox" :aria-label="t('search.results')" class="min-h-0 flex-1 overflow-y-auto py-1">
      <p v-if="!flat.length" class="px-3 py-6 text-center text-[12px] text-dim2" data-testid="search-empty">
        {{ t("search.empty") }}
      </p>
      <template v-for="group in groups" :key="group.kind">
        <div class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] tracking-wide text-dim2 uppercase">
          <Icon :name="KIND_ICON[group.kind]" :size="10" />
          {{
            group.kind === "session" ? t("search.type.session") : group.kind === "nav" ? t("search.kind.nav") : t("search.kind.settings")
          }}
        </div>
        <button
          v-for="item in group.items"
          :id="`search-option-${flatIndexById.get(item.id)}`"
          :key="item.id"
          type="button"
          role="option"
          data-testid="search-result"
          :data-kind="item.kind"
          :aria-selected="flatIndexById.get(item.id) === activeIndex"
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors"
          :class="flatIndexById.get(item.id) === activeIndex ? 'bg-cyan/10' : 'hover:bg-panel'"
          @mousemove="activeIndex = flatIndexById.get(item.id) ?? 0"
          @click="select(item)"
        >
          <SessionStatusIndicator v-if="item.kind === 'session'" :status="item.status ?? 'idle'" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[12.5px] text-foreground">{{ item.label }}</span>
            <span v-if="item.description" class="block truncate text-[10.5px] text-dim2">{{ item.description }}</span>
          </span>
          <Icon name="right" :size="12" class="shrink-0 text-dim2" />
        </button>
      </template>
    </div>

    <div class="flex shrink-0 items-center justify-between border-t border-line px-3 py-1 text-[10px] text-dim2">
      <span>{{ t("search.hint") }}</span>
      <span data-testid="search-count">{{ t("search.count", { n: flat.length }) }}</span>
    </div>
  </PopoverContent>
</template>
