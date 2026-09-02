<script setup lang="ts">
/**
 * ACP 会话配置选择胶囊（对齐 AionUi AcpModelSelector / AgentModeSelector 形态）：
 * 从 acpConfigOptions 快照渲染 select 型选项（model / thought_level / session_mode 等）。
 * 三态：
 *  - 无 config options（runtime 未探测）→ 只读胶囊 + 重启按钮（外部渲染）
 *  - 只有当前值无可选项 → 只读展示当前值
 *  - 可切换 → 点击弹选项列表，切换走 setAcpConfig（后端确认后 config-options 事件回填）
 * 切换中 loading 禁用；失败保留原值。
 */
import { computed, ref } from "vue";
import { useAgentStore } from "../../stores/agent";
import AionIcon from "./AionIcon.vue";

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
  icon?: string;
}>();

const agent = useAgentStore();
const open = ref(false);
const switching = ref(false);

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
  const prefix = props.showName && option.value.name ? `${option.value.name} · ` : "";
  const value = option.value.currentValue;
  if (value === null || value === undefined || value === "") return `${prefix}${props.placeholder ?? "—"}`;
  const choice = option.value.options?.find((candidate) => String(candidate.value) === String(value));
  return `${prefix}${choice?.name ?? String(value)}`;
});

const choices = computed(() => option.value?.options ?? []);

const selectable = computed(() => choices.value.length > 1);

async function pick(value: string): Promise<void> {
  if (!option.value || !selectable.value || switching.value) return;
  const current = String(option.value.currentValue ?? "");
  if (value === current) {
    open.value = false;
    return;
  }
  switching.value = true;
  try {
    await agent.setAcpConfig(option.value.id, value);
    open.value = false;
  } finally {
    switching.value = false;
  }
}

function toggle(): void {
  if (selectable.value && !switching.value) open.value = !open.value;
}
</script>

<template>
  <div class="relative">
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
      <AionIcon v-if="icon" :name="icon" :size="11" class="text-dim" />
      <span class="max-w-[200px] truncate whitespace-nowrap">{{ label }}</span>
      <span v-if="switching" class="size-2.5 animate-spin rounded-full border border-cyan border-t-transparent" />
      <AionIcon v-else-if="selectable" name="down" :size="10" class="text-dim2" />
    </button>

    <div
      v-if="open && selectable"
      class="absolute right-0 top-full z-20 mt-1 min-w-[180px] rounded-[10px] border border-line bg-popover p-1 shadow-lg"
      role="menu"
    >
      <button
        v-for="choice in choices"
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
        <AionIcon
          :name="String(choice.value) === String(option?.currentValue ?? '') ? 'check-one' : 'circle'"
          :size="11"
          class="shrink-0 text-dim"
        />
        <span class="truncate">{{ choice.name ?? String(choice.value) }}</span>
      </button>
    </div>
  </div>
</template>
