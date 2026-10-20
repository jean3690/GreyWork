<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { useSessionStore } from "@/stores/session";
import { useCapabilityLoader } from "@/plugins/current";
import { buildNavItems } from "@/lib/nav-items";
import type { SessionSort } from "@/lib/grouped";
import Icon from "@/features/shared/Icon.vue";
import GroupedHistory from "@/features/workspace/GroupedHistory.vue";
import SiderFooter from "@/features/shell/SiderFooter.vue";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { hostOs } from "@/lib/host-platform";
import { i18n } from "@/i18n";
import logoUrl from "@/assets/logo.svg?url";

/**
 * 左侧栏（唯一一套外壳）。
 *
 * 取舍是**刻意的**：
 * - 无折叠轨道、无品牌开合键 —— 只此一档，不需要在「完整 / 图标轨道」间切换；
 *   折叠/展开由标题栏的 `toggleSider` 承担；
 * - 快捷入口沿用 `buildNavItems`（远程助手 / 自动化任务 / 团队 + 插件 modes），
 *   但**不渲染** `SiderRegions`（插件左栏分组）与 `CoworkSiderSection`（协作运行嵌套）——
 *   取舍是「瘦」。协作运行仍可从「团队」入口进入；插件 modes 也已在导航行里。
 * - 「会话」段头（参考截图的 Sessions 头）：新建 · 排序 / 筛选。历史列表由 `GroupedHistory` 承担，
 *   它自带搜索框，故这里不再重复放搜索键；排序 / 筛选状态在本组件，经 props 转发下去。
 *
 * 因为不渲染协作嵌套区，这里**不**把协作成员位会话从历史里摘出去（摘了就没有别处展示它们）；
 * 完整 Sider 才会传 excludeSessionIds。
 */
const emit = defineEmits<{ newChat: []; navigate: [path: string]; openSettings: [] }>();

const props = defineProps<{
  /** 窄屏抽屉模式：absolute 悬浮于内容之上（配合遮罩），不挤占主区宽度 */
  overlay?: boolean;
}>();

const route = useRoute();
const sessionStore = useSessionStore();
/** 外壳组件不装 i18n 插件也要能渲染，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/** 高亮哪条会话：URL 参数优先，直接落 /guid 时退回 store 的激活项（与 Sider 一致）。 */
const activeSessionId = computed<string | null>(() => {
  const raw = route.params.conversationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (id && sessionStore.getSession(id)) return id;
  return sessionStore.activeSessionId;
});

/** 快捷入口 = 内置 + 插件贡献的 modes（seam 快照，响应式）。 */
const navItems = computed(() => buildNavItems(useCapabilityLoader().snapshot().modes));

/** 平台修饰键前缀（kbd 提示）：与标题栏搜索提示同一套判断（hostOs 未回时按非 mac）。 */
const modKey = computed(() => (hostOs.value === "macos" ? "⌘" : "Ctrl"));

/** 「会话」列表的排序档与筛选。视图偏好，暂不落盘（重建即回默认）。 */
const sortMode = ref<SessionSort>("recent");
const onlyActiveWorkspace = ref(false);
</script>

<template>
  <aside
    class="flex shrink-0 flex-col overflow-hidden border-r border-line-2 bg-panel-2"
    :class="props.overlay ? 'absolute inset-y-0 left-0 z-40 w-[232px] shadow-[8px_0_24px_rgba(0,0,0,0.18)]' : 'relative w-[232px]'"
    data-testid="grey-minimal-sider"
  >
    <!-- 品牌行：极简模式无折叠概念，纯品牌标识 -->
    <div class="flex h-[52px] shrink-0 items-center gap-2 px-3">
      <img :src="logoUrl" alt="" class="size-6 shrink-0 rounded-[calc(7px*var(--gw-radius-scale))]" width="24" height="24" />
      <span class="truncate font-display text-[14px] font-semibold tracking-tight text-foreground"> GreyWork </span>
    </div>

    <!-- 快捷入口：与完整 Sider 同源，样式保持一致 -->
    <div class="flex flex-col gap-0.5 px-2">
      <button
        v-for="item in navItems"
        :key="item.path"
        class="flex h-[34px] cursor-pointer items-center gap-2 rounded-[calc(8px*var(--gw-radius-scale))] px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
        :class="route.path === item.path ? 'bg-panel text-foreground' : 'text-dim hover:bg-panel hover:text-foreground'"
        @click="emit('navigate', item.path)"
      >
        <span class="grid size-5 place-items-center rounded-[calc(5px*var(--gw-radius-scale))] bg-panel text-dim">
          <Icon :name="item.icon" :size="14" />
        </span>
        {{ item.label }}
      </button>
    </div>

    <!-- 「会话」段头：新建 + 排序（排序为延迟占位，见 Hint 与 aria-disabled） -->
    <div class="flex h-8 shrink-0 items-center gap-1 px-2 pt-3">
      <span class="text-[10.5px] font-medium tracking-wide text-dim2 uppercase">{{ t("minimal.sessions") }}</span>
      <div class="ml-auto flex items-center gap-1">
        <button
          type="button"
          data-testid="minimal-new-session"
          class="flex h-[26px] cursor-pointer items-center gap-1 rounded-[calc(7px*var(--gw-radius-scale))] border border-line-2 bg-panel px-2 text-[11.5px] text-dim transition-colors hover:border-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
          @click="emit('newChat')"
        >
          <Icon name="plus" :size="12" />
          {{ t("minimal.newSession") }}
          <kbd class="ml-0.5 font-mono text-[10px] text-dim2">{{ modKey }}+N</kbd>
        </button>
        <!-- 排序 / 筛选：排序档 + 「只看当前工作区」，状态转发给 GroupedHistory -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              data-testid="minimal-session-sort"
              class="grid size-[26px] shrink-0 cursor-pointer place-items-center rounded-[calc(7px*var(--gw-radius-scale))] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              :aria-label="t('minimal.sortLabel')"
            >
              <Icon name="more" :size="13" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end" class="w-[200px] border-line">
            <DropdownMenuLabel class="px-2 py-1 text-[10.5px] font-medium tracking-wide text-dim2 uppercase">
              {{ t("minimal.sortLabel") }}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup :model-value="sortMode">
              <DropdownMenuRadioItem
                value="recent"
                data-testid="minimal-sort-recent"
                class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px]"
                :class="sortMode === 'recent' ? 'text-foreground' : 'text-dim'"
                @select="sortMode = 'recent'"
              >
                <template #indicator-icon><span></span></template>
                <span>{{ t("minimal.sortRecent") }}</span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="title"
                data-testid="minimal-sort-title"
                class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px]"
                :class="sortMode === 'title' ? 'text-foreground' : 'text-dim'"
                @select="sortMode = 'title'"
              >
                <template #indicator-icon><span></span></template>
                <span>{{ t("minimal.sortTitle") }}</span>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator class="bg-line-2" />
            <DropdownMenuLabel class="px-2 py-1 text-[10.5px] font-medium tracking-wide text-dim2 uppercase">
              {{ t("minimal.filterLabel") }}
            </DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              data-testid="minimal-filter-only-active"
              :model-value="onlyActiveWorkspace"
              class="cursor-pointer gap-2 rounded-[calc(6px*var(--gw-radius-scale))] py-1.5 text-[12px] text-dim"
              @update:model-value="onlyActiveWorkspace = $event"
            >
              <template #indicator-icon><span></span></template>
              <Icon :name="onlyActiveWorkspace ? 'check-one' : 'folder'" :size="12" class="shrink-0 text-dim" />
              <span>{{ t("minimal.filterOnlyActive") }}</span>
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>

    <GroupedHistory
      :active-session-id="activeSessionId"
      :sort="sortMode"
      :only-active-workspace="onlyActiveWorkspace"
      @navigate="emit('navigate', $event)"
    />

    <SiderFooter @open-settings="emit('openSettings')" @navigate="emit('navigate', $event)" />
  </aside>
</template>
