<script setup lang="ts">
import { onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import SettingsView from "../views/SettingsView.vue";

/**
 * 设置弹窗：左栏分区导航 + 右侧内容面板（views/SettingsView）。
 *
 * 原来是一整个 /settings/:section 路由页：为了改一项偏好要把会话整页换掉，返回键
 * 语义也变得暧昧（回的是上一页还是上一个分区？）。改成 Shell 持有的模态层之后，
 * 修改即时落到 store、身后页面不动，Esc / 点遮罩即可退出。
 *
 * open / section 都在 Shell（受控）：这类瞬时 UI 状态进 URL 只会让历史栈塞满无关条目，
 * 而且弹窗不该被分享/刷新复现——它不是一个「地点」。
 */
const props = defineProps<{ open: boolean; section: string }>();

const emit = defineEmits<{ "update:open": [open: boolean]; "update:section": [section: string] }>();

/** 只列 key 与图标；文案统一取 settings.sections.*.title（与 SettingsView 的头部同源）。 */
const sections = [
  { key: "agent", icon: "robot" },
  { key: "assistant", icon: "magic" },
  { key: "appearance", icon: "sun" },
  { key: "mode", icon: "hammer" },
  { key: "system", icon: "setting" },
  { key: "mcp", icon: "terminal" },
  { key: "skills", icon: "lightning" },
  { key: "storage", icon: "folder" },
  { key: "team", icon: "peoples" },
] as const;

const { t } = useI18n();

function close(): void {
  emit("update:open", false);
}

function select(key: string): void {
  emit("update:section", key);
}

/** Esc 关弹窗挂在 window 上：焦点可能在弹窗内任意控件，挂在容器上收不到那次 keydown。 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
}

watch(
  () => props.open,
  (open) => {
    if (typeof window === "undefined") return;
    if (open) window.addEventListener("keydown", onWindowKeydown);
    else window.removeEventListener("keydown", onWindowKeydown);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof window === "undefined") return;
  window.removeEventListener("keydown", onWindowKeydown);
});

function rowClass(active: boolean): string {
  return [
    "flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:bg-panel hover:text-foreground",
  ].join(" ");
}
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    :aria-label="t('settings.title')"
    data-testid="settings-dialog"
    @click.self="close"
  >
    <div class="flex max-h-[86vh] w-full max-w-[880px] flex-col rounded-[14px] border border-line bg-panel shadow-xl">
      <header class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <span class="text-[13px] font-medium text-foreground">{{ t("settings.title") }}</span>
        <button
          type="button"
          class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim transition-colors hover:bg-panel-2 hover:text-foreground"
          :aria-label="t('settings.close')"
          data-testid="settings-close"
          @click="close"
        >
          <Icon name="close" :size="13" />
        </button>
      </header>

      <div class="flex min-h-0 flex-1 overflow-hidden border-t border-line">
        <nav class="w-[132px] shrink-0 overflow-y-auto border-r border-line px-2 py-2 sm:w-[168px]">
          <button
            v-for="item in sections"
            :key="item.key"
            :class="rowClass(props.section === item.key)"
            :data-testid="`settings-nav-${item.key}`"
            :aria-current="props.section === item.key ? 'page' : undefined"
            @click="select(item.key)"
          >
            <span class="grid size-5 place-items-center rounded-[5px] bg-panel text-dim">
              <Icon :name="item.icon" :size="14" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ t(`settings.sections.${item.key}.title`) }}</span>
          </button>
        </nav>

        <div class="min-h-0 flex-1 overflow-hidden">
          <SettingsView :section="props.section" />
        </div>
      </div>
    </div>
  </div>
</template>
