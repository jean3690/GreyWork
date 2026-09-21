<script setup lang="ts">
/**
 * 底部活动面板宿主（region = activityPanel）。
 *
 * 每个常驻贡献 = 一个页签（标题用 contribution.title 原文，不翻译），激活者渲染内容；
 * `overflow` 贡献不占标签条，收进条尾「更多」下拉。整个条带 read-only 常驻 ——
 * 只有折叠/展开（高度 0 ↔ 220px）与激活页签切换，没有「关闭单个页签」：
 * 页签由插件贡献，插件停用即整组消失（seam 响应式）。
 *
 * 贡献在 Shell onMounted 的 bootPlugins() 之后才陆续注册，所以宿主全部从
 * computed(snapshot().uiRegions) 派生 —— 注册/停用自动增删条带，无需事件订阅。
 * store 是哑 pref 持有者：持久化的 activeTabId 失效时由 resolveActiveTab 在显示层回退。
 */
import { computed, ref, watch } from "vue";
import Icon from "@/features/shared/Icon.vue";
import { ACTIVITY_BAND_HEIGHT_PX } from "@/lib/layout";
import { partitionActivityTabs, resolveActiveTab, sortUiRegions } from "@/lib/ui-regions";
import { useCapabilityLoader } from "@/plugins/current";
import { useActivityStore } from "@/stores/activity";
import Hint from "@/features/shared/Hint.vue";
import ContextMenuRegion from "@/features/shared/ContextMenuRegion.vue";
import type { UiRegionContribution } from "@/plugins/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { buildActivityTabItems, type ContextMenuItem, type ContextTarget } from "@/lib/context-menu";
import { i18n } from "@/i18n";

const activity = useActivityStore();
const overflowOpen = ref(false);
/** 外壳组件不装 i18n 插件也要能渲染，故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/** activityPanel 区贡献：按 order 排序后分区为 常驻 / 「更多」。 */
const contributions = computed(() =>
  sortUiRegions(
    useCapabilityLoader()
      .snapshot()
      .uiRegions.filter((region) => region.region === "activityPanel"),
  ),
);
const partitioned = computed(() => partitionActivityTabs(contributions.value));

/**
 * 激活贡献：store 里的 id 仍是任意贡献（常驻或「更多」里的 overflow）则用之 ——
 * 从「更多」选中的面板不占条位但照常显示内容，条尾按钮高亮提示；
 * 失效（插件被停）回退首个常驻页签。
 */
const active = computed<UiRegionContribution | null>(() => {
  const allIds = contributions.value.map((c) => c.id);
  const pinnedIds = partitioned.value.pinned.map((c) => c.id);
  const id = resolveActiveTab(allIds, pinnedIds, activity.activeTabId);
  return contributions.value.find((c) => c.id === id) ?? null;
});

/** 当前激活面板是否来自「更多」（常驻条位上没有它的标签）。 */
const activeIsOverflow = computed(() => {
  const current = active.value;
  return current !== null && !partitioned.value.pinned.some((c) => c.id === current.id);
});

const tabClass = (isActive: boolean): string =>
  [
    "h-6 shrink-0 cursor-pointer rounded-[6px] px-2 text-[11.5px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    isActive ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");

function activate(id: string): void {
  activity.activate(id);
  overflowOpen.value = false;
}

/** 标签条右键菜单：命中标签给「切换到该面板」，否则只给「收起活动面板」。 */
function buildMenu(target: ContextTarget | null): ContextMenuItem[] {
  return buildActivityTabItems(target, t, {
    activate,
    collapse: () => activity.setOpen(false),
  });
}

/** 「更多」下拉：Esc / 点外部 / 选中项后的收起全交给 DropdownMenu（含键盘漫游与翻转碰撞处理）。 */

/** 最后一个「更多」项也被停用时，下拉不能开着空壳。 */
watch(
  () => partitioned.value.overflow.length,
  (length) => {
    if (length === 0) overflowOpen.value = false;
  },
);
</script>

<template>
  <section
    v-if="activity.available && partitioned.pinned.length"
    data-testid="activity-band"
    class="relative shrink-0 overflow-hidden bg-panel-2 transition-[height] duration-150"
    :class="activity.open ? 'border-t border-line-2' : ''"
    :style="{ height: activity.open ? `${ACTIVITY_BAND_HEIGHT_PX}px` : '0px' }"
    :aria-hidden="activity.open ? undefined : 'true'"
  >
    <div class="flex h-full flex-col">
      <!-- 标签条：与右栏区段条同一节奏 -->
      <ContextMenuRegion :build="buildMenu">
        <div class="flex h-[34px] shrink-0 items-center gap-1 border-b border-line px-3">
          <Hint v-for="contribution in partitioned.pinned" :key="contribution.id" :text="contribution.id">
            <button
              type="button"
              data-testid="activity-tab"
              data-ctx="activity-tab"
              :data-tab-id="contribution.id"
              :class="tabClass(contribution.id === active?.id)"
              :aria-current="contribution.id === active?.id ? 'true' : undefined"
              @click="activate(contribution.id)"
            >
              {{ contribution.title }}
            </button>
          </Hint>

          <div class="ms-auto flex shrink-0 items-center gap-0.5">
            <!-- 低频面板收进「更多」，不占常驻标签位 -->
            <div v-if="partitioned.overflow.length" class="relative">
              <DropdownMenu v-model:open="overflowOpen">
                <DropdownMenuTrigger as-child>
                  <button
                    type="button"
                    data-testid="activity-overflow-toggle"
                    class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
                    :class="overflowOpen || activeIsOverflow ? 'bg-panel text-foreground' : ''"
                    aria-label="更多面板"
                  >
                    <Icon name="more" :size="13" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent data-testid="activity-overflow-menu" side="top" align="end" class="min-w-[120px] border-line-2">
                  <DropdownMenuItem
                    v-for="contribution in partitioned.overflow"
                    :key="contribution.id"
                    data-testid="activity-overflow-item"
                    class="h-6 cursor-pointer rounded-[5px] px-2 text-[11.5px] text-dim"
                    @select="activate(contribution.id)"
                  >
                    {{ contribution.title }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <button
              type="button"
              data-testid="activity-collapse"
              class="grid size-6 cursor-pointer place-items-center rounded-[6px] text-dim2 transition-colors hover:bg-panel hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
              aria-label="收起活动面板"
              @click="activity.setOpen(false)"
            >
              <Icon name="down" :size="13" />
            </button>
          </div>
        </div>
      </ContextMenuRegion>

      <!-- 内容区：收起时 v-show 隐藏但保持挂载，插件面板的滚动位置/状态不丢 -->
      <div v-show="activity.open" class="min-h-0 flex-1 overflow-hidden">
        <component :is="active?.component" v-if="active" :key="active.id" />
      </div>
    </div>
  </section>
</template>
