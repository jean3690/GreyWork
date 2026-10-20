<script setup lang="ts">
/**
 * Office 文档的「原生 / 高保真(PDF)」切换（分段控件）。
 *
 * 纯展示 + 写 store：值来自 `tab.officeView`，未显式设置时回落到
 * 「soffice 可用则 pdf，否则 native」这一宿主事实。切换即写 `preview.setOfficeView`，
 * 由 PreviewSurface 据此改派 viewer —— 本组件不感知具体 viewer。
 *
 * 与表格的 `PreviewModeSwitch` 同一形态，区别在：soffice 不在场时「高保真」选项没有意义，
 * 直接不渲染（除非当前正卡在 pdf —— 那种情况要留一个能切回原生的出口）。
 */
import { computed } from "vue";
import { usePreviewStore } from "@/stores/preview";
import { useOfficeConvertStore } from "@/stores/office-convert";
import { i18n } from "@/i18n";
import type { OfficeViewMode, PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

const preview = usePreviewStore();
const convert = useOfficeConvertStore();
// 与其他 viewer 一致走 i18n 单例（而非 useI18n()），这样测试里不装 i18n 插件也能挂载。
const t = i18n.global.t;

const value = computed<OfficeViewMode>(() => props.tab.officeView ?? (convert.available ? "pdf" : "native"));

/** soffice 不在场且没有强制停在 pdf 时，只有一个选项，分段控件没意义。 */
const showSwitch = computed(() => convert.loaded && (convert.available || value.value === "pdf"));

function set(next: OfficeViewMode): void {
  preview.setOfficeView(props.tab.id, next);
}

function optionClass(active: boolean): string {
  return [
    "h-5 shrink-0 cursor-pointer rounded-[calc(5px*var(--gw-radius-scale))] px-2 text-[11px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan",
    active ? "bg-panel text-foreground" : "text-dim hover:text-foreground",
  ].join(" ");
}
</script>

<template>
  <div
    v-if="showSwitch"
    class="flex shrink-0 items-center gap-0.5 rounded-[calc(7px*var(--gw-radius-scale))] border border-line-2 bg-panel-2 p-0.5"
    role="group"
    :aria-label="t('preview.mode.officeLabel')"
  >
    <button
      type="button"
      data-testid="office-view-native"
      :class="optionClass(value === 'native')"
      :aria-pressed="value === 'native'"
      @click="set('native')"
    >
      {{ t("preview.mode.officeNative") }}
    </button>
    <button
      type="button"
      data-testid="office-view-pdf"
      :class="optionClass(value === 'pdf')"
      :aria-pressed="value === 'pdf'"
      @click="set('pdf')"
    >
      {{ t("preview.mode.officePdf") }}
    </button>
  </div>
</template>
