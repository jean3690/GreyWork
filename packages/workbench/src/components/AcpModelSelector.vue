<script setup lang="ts">
/**
 * ACP 会话配置选择胶囊（对齐 GreyWork AcpModelSelector / AgentModeSelector 形态）：
 * 从 acpConfigOptions 快照渲染 select 型选项（model / thought_level / session_mode 等）。
 * 三态：
 *  - 无 config options（runtime 未探测）→ 只读胶囊 + 重启按钮（外部渲染）
 *  - 只有当前值无可选项 → 只读展示当前值
 *  - 可切换 → 点击弹选项面板，切换走 setAcpConfig（后端确认后 config-options 事件回填）
 * 选项面板：长列表（≥12 项，如 opencode 的 734 个模型）带搜索过滤 + 限高滚动，
 * 支持 Esc 关闭与点击外部关闭。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePanelPlacement } from "../lib/panel-placement";
import { useAgentStore } from "../stores/agent";
import Icon from "./Icon.vue";

const props = defineProps<{
  /** config option id，如 "model" / "thought_level"；缺省渲染第一个 select 型 */
  optionId?: string;
  /** 候选 id 列表（按序精确匹配）；给了候选项就不再回落到任意 select 型——
   *  避免多个胶囊同时命中同一个配置项。 */
  optionIds?: string[];
  /** 无内容时的占位文案（如 "Use CLI model"） */
  placeholder?: string;
  /** 标签前冠配置项名（额外配置项没有专属图标，靠名字区分） */
  showName?: boolean;
  /** showName 时的展示名覆盖（默认用 agent 给的 option.name，如 Effort → 思考强度） */
  label?: string;
  icon?: string;
}>();

const agent = useAgentStore();
const open = ref(false);
const switching = ref(false);
const query = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);

/** 目标 select 型配置项。 */
const option = computed(() => {
  const list = agent.acpConfigOptions;
  if (props.optionIds?.length) {
    for (const id of props.optionIds) {
      const hit = list.find((entry) => entry.id === id && entry.type === "select");
      if (hit) return hit;
    }
    return null;
  }
  const id = props.optionId;
  return list.find((entry) => (id ? entry.id === id : entry.type === "select")) ?? list.find((entry) => entry.type === "select") ?? null;
});

const label = computed(() => {
  if (!option.value) return props.placeholder ?? "—";
  const displayName = props.label ?? option.value.name;
  const prefix = props.showName && displayName ? `${displayName} · ` : "";
  const value = option.value.currentValue;
  if (value === null || value === undefined || value === "") return `${prefix}${props.placeholder ?? "—"}`;
  const choice = option.value.options?.find((candidate) => String(candidate.value) === String(value));
  return `${prefix}${choice?.name ?? String(value)}`;
});

const choices = computed(() => option.value?.options ?? []);

const selectable = computed(() => choices.value.length > 1);

/** 长列表才需要搜索（opencode 模型池 700+）；三五项的 effort/mode 面板保持轻量。 */
const showSearch = computed(() => choices.value.length >= 12);

/** 搜索过滤：匹配显示名与值（如 "gpt-5" 或 "gpt-5.6-sol"）。 */
const visibleChoices = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return choices.value;
  return choices.value.filter((choice) => {
    const name = String(choice.name ?? "").toLowerCase();
    const value = String(choice.value).toLowerCase();
    return name.includes(q) || value.includes(q);
  });
});

/** 面板估算高：列表（每项约 30px，上限同 max-h 的 320）+ 搜索行 40 + 内边距与边框 12。 */
const panelHeight = (): number => Math.min(320, visibleChoices.value.length * 30) + (showSearch.value ? 40 : 0) + 12;

/** 输入卡贴底时向下会出界 → 按上下净空翻转（openUp = bottom-full）。 */
const { openUp, alignLeft, place: placePanel } = usePanelPlacement(rootEl, panelHeight, 340);

function openMenu(): void {
  if (!selectable.value || switching.value) return;
  placePanel();
  query.value = "";
  open.value = true;
  if (showSearch.value) void nextTick(() => searchInput.value?.focus());
}

function closeMenu(): void {
  open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) {
    query.value = "";
    if (showSearch.value) void nextTick(() => searchInput.value?.focus());
  }
});

// 点击面板外任意处关闭（含点发送/切胶囊）
function onPointerDown(event: PointerEvent): void {
  if (open.value && rootEl.value && !rootEl.value.contains(event.target as Node)) closeMenu();
}
onMounted(() => document.addEventListener("pointerdown", onPointerDown));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onPointerDown));

async function pick(value: string): Promise<void> {
  if (!option.value || !selectable.value || switching.value) return;
  const current = String(option.value.currentValue ?? "");
  if (value === current) {
    closeMenu();
    return;
  }
  switching.value = true;
  try {
    await agent.setAcpConfig(option.value.id, value);
    closeMenu();
  } finally {
    switching.value = false;
  }
}

function toggle(): void {
  if (!selectable.value || switching.value) return;
  if (open.value) closeMenu();
  else openMenu();
}
</script>

<template>
  <div ref="rootEl" class="relative">
    <button
      type="button"
      :class="[
        'flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan',
        selectable
          ? 'cursor-pointer border-line bg-panel-2 text-dim hover:border-line-2 hover:text-foreground'
          : 'cursor-default border-line bg-panel-2 text-dim2',
      ]"
      :aria-haspopup="selectable ? 'menu' : undefined"
      :aria-expanded="open"
      :disabled="switching"
      @click="toggle"
    >
      <Icon v-if="icon" :name="icon" :size="11" class="text-dim" />
      <span class="max-w-[200px] truncate whitespace-nowrap">{{ label }}</span>
      <span v-if="switching" class="size-2.5 animate-spin rounded-full border border-cyan border-t-transparent" />
      <Icon v-else-if="selectable" name="down" :size="10" class="text-dim2" />
    </button>

    <div
      v-if="open && selectable"
      class="absolute z-40 w-[min(340px,calc(100vw-16px))] rounded-[10px] border border-line bg-popover shadow-lg"
      :class="[openUp ? 'bottom-full mb-1' : 'top-full mt-1', alignLeft ? 'left-0' : 'right-0']"
      @keydown.esc.prevent="closeMenu"
    >
      <div v-if="showSearch" class="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
        <Icon name="search" :size="13" class="shrink-0 text-dim2" />
        <input
          ref="searchInput"
          v-model="query"
          type="text"
          class="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-dim2"
          placeholder="搜索模型…"
          :aria-label="'搜索' + (option?.name ?? '选项')"
        />
        <span v-if="query" class="shrink-0 font-mono text-[10.5px] text-dim2"> {{ visibleChoices.length }}/{{ choices.length }} </span>
      </div>
      <div role="menu" class="max-h-[min(320px,55vh)] overflow-y-auto p-1">
        <button
          v-for="choice in visibleChoices"
          :key="String(choice.value)"
          type="button"
          role="menuitemradio"
          :aria-checked="String(choice.value) === String(option?.currentValue ?? '')"
          :class="[
            'flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-panel-2',
            String(choice.value) === String(option?.currentValue ?? '') ? 'text-foreground' : 'text-dim hover:text-foreground',
          ]"
          @click="pick(String(choice.value))"
        >
          <Icon
            :name="String(choice.value) === String(option?.currentValue ?? '') ? 'check-one' : 'circle'"
            :size="11"
            class="shrink-0 text-dim"
          />
          <span class="truncate">{{ choice.name ?? String(choice.value) }}</span>
        </button>
        <p v-if="visibleChoices.length === 0" class="px-2 py-3 text-center text-[11.5px] text-dim2">无匹配选项</p>
      </div>
    </div>
  </div>
</template>
