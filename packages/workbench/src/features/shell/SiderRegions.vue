<script setup lang="ts">
/**
 * 左栏插件分组宿主（region = shellSidebar）。
 *
 * 每个贡献 = 一个分组：标题（小标大写样式）+ 内容块，排在 Sider 快捷入口与
 * 会话历史之间（宿主自带收尾分隔线，空时不渲染、布局回到现状）。
 * `overflow` 对 shellSidebar 不生效：竖向分组没有标签条压力，隐藏一组反而
 * 会把它锁死在 248px 栏里（见 plugins/types.ts）。
 *
 * 同 ActivityBand：全部从 computed(snapshot().uiRegions) 派生，插件启停即增删分组。
 * 整体高度封顶（超出内部滚动），避免单个高分组把历史区压垮。
 */
import { computed } from "vue";
import { SIDEBAR_REGIONS_MAX_HEIGHT_PX } from "@/lib/layout";
import { sortUiRegions } from "@/lib/ui-regions";
import { useCapabilityLoader } from "@/plugins/current";

const groups = computed(() =>
  sortUiRegions(
    useCapabilityLoader()
      .snapshot()
      .uiRegions.filter((region) => region.region === "shellSidebar"),
  ),
);
</script>

<template>
  <div
    v-if="groups.length"
    data-testid="sider-regions"
    class="flex shrink-0 flex-col overflow-y-auto"
    :style="{ maxHeight: `${SIDEBAR_REGIONS_MAX_HEIGHT_PX}px` }"
  >
    <div v-for="group in groups" :key="group.id" data-testid="sider-region" class="flex flex-col">
      <div :data-testid="`sider-region-${group.id}`" class="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-dim2">
        {{ group.title }}
      </div>
      <div class="px-2">
        <component :is="group.component" :key="group.id" />
      </div>
    </div>
    <div class="mx-2 my-2 h-px shrink-0 bg-line-2" />
  </div>
</template>
