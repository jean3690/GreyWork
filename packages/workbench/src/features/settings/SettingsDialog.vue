<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import Icon from "@/features/shared/Icon.vue";
import SettingsView from "@/features/settings/SettingsView.vue";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

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

/** 只列 key 与图标；文案统一取 settings.sections.*.title（与 SettingsView 的头部同源）。
 *  清单在 lib/settings-sections：标题栏搜索读同一份。 */
const sections = SETTINGS_SECTIONS;

const { t } = useI18n();

function close(): void {
  emit("update:open", false);
}

function select(key: string): void {
  emit("update:section", key);
}

/**
 * Dialog 的 Esc / 点遮罩关闭统一走这里，签名与对外 emit 一致，直接转发。
 * 之前那份挂在 window 上的 keydown 已删：reka 的 DismissableLayer 用 onKeyStroke
 * 监听 window 上的 Escape，焦点在弹窗内任意控件都收得到，不用自己兜。
 */
function onOpenChange(next: boolean): void {
  emit("update:open", next);
}

function rowClass(active: boolean): string {
  return [
    "flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:bg-panel hover:text-foreground",
  ].join(" ");
}
</script>

<template>
  <Dialog :open="open" @update:open="onOpenChange">
    <DialogContent
      :show-close-button="false"
      data-testid="settings-dialog"
      class="flex max-h-[86vh] flex-col gap-0 overflow-hidden rounded-[14px] border-line bg-panel p-0 shadow-xl sm:max-w-[880px]"
    >
      <header class="flex items-center justify-between px-4 pb-2 pt-3.5">
        <DialogTitle class="text-[13px] font-medium text-foreground">{{ t("settings.title") }}</DialogTitle>
        <!-- 仅给读屏：弹层必须有 Description（否则 aria-describedby 指向不存在的节点），
             但「设置」这个标题已经够直白，可见文案只会多一行噪音。 -->
        <DialogDescription class="sr-only">{{ t("settings.sub") }}</DialogDescription>
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
    </DialogContent>
  </Dialog>
</template>
