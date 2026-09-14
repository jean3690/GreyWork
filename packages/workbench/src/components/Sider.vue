<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useSessionStore } from "../stores/session";
import { useCapabilityLoader } from "../plugins/current";
import Icon from "./Icon.vue";
import GroupedHistory from "./GroupedHistory.vue";
import SiderFooter from "./SiderFooter.vue";
import SiderToolbar from "./SiderToolbar.vue";
import SiderRegions from "./SiderRegions.vue";

/**
 * GreyWork 风格左侧栏：品牌入口 + 新对话 + 快捷入口 + 会话历史。
 * 折叠保留 52px 品牌图标轨道；点击图标即可恢复完整侧栏。
 * 设置不再是路由页（整列换成设置导航的旧行为已成历史），改由 Shell 的弹窗承载。
 */
const props = defineProps<{
  collapsed: boolean;
  /** 窄屏抽屉模式：absolute 悬浮于内容之上（配合遮罩），不挤占主区宽度 */
  overlay?: boolean;
}>();

const emit = defineEmits<{ newChat: []; navigate: [path: string]; toggleSider: []; openSettings: [] }>();

const route = useRoute();
const sessionStore = useSessionStore();

/** 高亮哪条会话：URL 参数优先，直接落 /guid 时退回 store 的激活项。 */
const activeSessionId = computed<string | null>(() => {
  const raw = route.params.conversationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (id && sessionStore.getSession(id)) return id;
  return sessionStore.activeSessionId;
});

const shortcuts = [
  { path: "/assistants", label: "远程助手", icon: "robot" },
  { path: "/scheduled", label: "定时任务", icon: "alarm-clock" },
  { path: "/team", label: "团队", icon: "peoples" },
] as const;

/**
 * 快捷入口 = 内置 + 插件贡献的 modes（seam 快照，响应式）。
 * 插件激活即出现入口，停用即消失；点击走 /plugin/:id 由 PluginView 宿主渲染。
 */
const navItems = computed(() => [
  ...shortcuts,
  ...useCapabilityLoader()
    .snapshot()
    .modes.map((mode) => ({ path: `/plugin/${mode.id}`, label: mode.title, icon: mode.icon ?? "magic" })),
]);
</script>

<template>
  <aside
    class="flex shrink-0 flex-col overflow-hidden border-r border-line-2 bg-panel-2 transition-[width] duration-150"
    :class="[
      props.collapsed ? 'w-[52px]' : 'w-[248px]',
      props.overlay ? 'absolute inset-y-0 left-0 z-40 shadow-[8px_0_24px_rgba(0,0,0,0.18)]' : 'relative',
    ]"
    data-testid="grey-sider"
  >
    <SiderToolbar :collapsed="props.collapsed" @toggle-sider="emit('toggleSider')" />
    <template v-if="!props.collapsed">
      <div class="px-2 pb-2">
        <button
          class="flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[8px] bg-accent px-2 text-[13px] font-medium text-accent-ink transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          data-testid="sider-new-chat"
          @click="emit('newChat')"
        >
          <span class="grid size-5 place-items-center">
            <Icon name="plus" :size="14" />
          </span>
          新对话
        </button>
      </div>

      <div class="flex flex-col gap-0.5 px-2">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="flex h-[34px] cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          :class="route.path === item.path ? 'bg-panel text-foreground' : 'text-dim hover:bg-panel hover:text-foreground'"
          @click="emit('navigate', item.path)"
        >
          <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
            <Icon :name="item.icon" :size="14" />
          </span>
          {{ item.label }}
        </button>
      </div>

      <div class="mx-2 my-2 h-px shrink-0 bg-line-2" />

      <!-- 插件贡献的左栏分组（shellSidebar）：无贡献时零渲染，布局回到现状 -->
      <SiderRegions />

      <GroupedHistory :active-session-id="activeSessionId" @navigate="emit('navigate', $event)" />

      <SiderFooter @open-settings="emit('openSettings')" @navigate="emit('navigate', $event)" />
    </template>
  </aside>
</template>
