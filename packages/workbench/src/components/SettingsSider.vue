<script setup lang="ts">
import Icon from "./Icon.vue";

/** 设置页侧栏导航：各子页入口 + 顶部返回按钮（回到进入设置前的路径）。 */
const props = defineProps<{
  currentSection: string;
  backPath: string;
}>();

const emit = defineEmits<{ navigate: [path: string] }>();

const sections = [
  { key: "agent", label: "Agent", icon: "robot", path: "/settings/agent" },
  { key: "assistant", label: "助手", icon: "magic", path: "/settings/assistant" },
  { key: "appearance", label: "外观", icon: "sun", path: "/settings/appearance" },
  { key: "mode", label: "运行模式", icon: "hammer", path: "/settings/mode" },
  { key: "system", label: "系统", icon: "setting", path: "/settings/system" },
  { key: "mcp", label: "MCP", icon: "terminal", path: "/settings/mcp" },
  { key: "storage", label: "存储", icon: "folder", path: "/settings/storage" },
  { key: "team", label: "团队", icon: "peoples", path: "/settings/team" },
] as const;

function rowClass(active: boolean): string {
  return [
    "flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:bg-panel hover:text-foreground",
  ].join(" ");
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
    <button :class="rowClass(false)" data-testid="settings-back" @click="emit('navigate', props.backPath)">
      <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
        <Icon name="arrow-left" :size="14" />
      </span>
      返回
    </button>

    <div class="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-dim2">设置</div>

    <button
      v-for="item in sections"
      :key="item.key"
      :class="rowClass(props.currentSection === item.key)"
      :data-testid="`settings-nav-${item.key}`"
      :aria-current="props.currentSection === item.key ? 'page' : undefined"
      @click="emit('navigate', item.path)"
    >
      <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
        <Icon :name="item.icon" :size="14" />
      </span>
      <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
      <Icon name="right" :size="12" class="text-dim2" />
    </button>
  </div>
</template>
