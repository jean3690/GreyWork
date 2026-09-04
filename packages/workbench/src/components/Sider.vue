<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useSessionStore } from "../stores/session";
import Icon from "./Icon.vue";
import GroupedHistory from "./GroupedHistory.vue";
import SettingsSider from "./SettingsSider.vue";
import SiderFooter from "./SiderFooter.vue";
import SiderToolbar from "./SiderToolbar.vue";

/**
 * GreyWork 风格左侧栏：品牌/新对话 + 快捷入口 + 会话历史，路径进入 /settings 时整列换成设置导航。
 * 折叠即宽度归零（overflow-hidden 兜住子元素），不做图标轨道——半宽轨道在 248px 栏下收益很低。
 */
const props = defineProps<{
  collapsed: boolean;
  theme: string;
  lastNonSettingsPath: string;
  /** 窄屏抽屉模式：absolute 悬浮于内容之上（配合遮罩），不挤占主区宽度 */
  overlay?: boolean;
}>();

const emit = defineEmits<{ newChat: []; navigate: [path: string]; toggleTheme: [] }>();

const route = useRoute();
const sessionStore = useSessionStore();

const isSettingsRoute = computed(() => route.path.startsWith("/settings"));

/** 高亮哪条会话：URL 参数优先，直接落 /guid 时退回 store 的激活项。 */
const activeSessionId = computed<string | null>(() => {
  const raw = route.params.conversationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (id && sessionStore.getSession(id)) return id;
  return sessionStore.activeSessionId;
});

const shortcuts = [
  { path: "/assistants", label: "助手", icon: "robot" },
  { path: "/scheduled", label: "定时任务", icon: "alarm-clock" },
  { path: "/team", label: "团队", icon: "peoples" },
] as const;
</script>

<template>
  <aside
    class="flex shrink-0 flex-col overflow-hidden border-r border-line-2 bg-panel-2 transition-[width] duration-150"
    :class="[
      props.collapsed ? 'w-0 border-r-0' : 'w-[248px]',
      props.overlay ? 'absolute inset-y-0 left-0 z-40 shadow-[8px_0_24px_rgba(0,0,0,0.18)]' : 'relative',
    ]"
    :aria-hidden="props.collapsed ? 'true' : undefined"
    data-testid="grey-sider"
  >
    <SiderToolbar :collapsed="props.collapsed" @new-chat="emit('newChat')" />

    <template v-if="isSettingsRoute">
      <SettingsSider
        :current-section="String(route.params.section ?? 'agent')"
        :back-path="props.lastNonSettingsPath"
        @navigate="emit('navigate', $event)"
      />
    </template>
    <template v-else>
      <div class="flex flex-col gap-0.5 px-2">
        <button
          v-for="item in shortcuts"
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

      <GroupedHistory :active-session-id="activeSessionId" @navigate="emit('navigate', $event)" />
    </template>

    <SiderFooter :theme="props.theme" @toggle-theme="emit('toggleTheme')" @navigate="emit('navigate', $event)" />
  </aside>
</template>
