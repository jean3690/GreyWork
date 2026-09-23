<script setup lang="ts">
/**
 * 「用系统应用打开」按钮 —— 预览侧的兜底出口。
 *
 * 三种场景都缺不了一个出口：文件太大读不进来（10MB / 20MB 上限）、二进制打不开、
 * 解析失败。以前只有 PDF 的错误文案里提了一句「可以点上方工具栏」，而那个按钮
 * 还得 tab 有磁盘孪生路径才在，用户未必找得到。
 *
 * 只在有磁盘孪生路径时渲染 —— 纯内存产物（vfs 未落盘）与抓来的网页没有本机文件可开。
 * 失败弹提醒而不是吞掉：宿主拿不到打开方式（路径被删 / 系统没关联程序）是用户必须
 * 知道的事。
 */
import { computed } from "vue";
import { isTauriRuntime } from "@greywork/core";
import { openWithSystemApp, resolveTabDiskPath } from "@/lib/open-external";
import { notify } from "@/stores/notice";
import { i18n } from "@/i18n";
import type { PreviewTab } from "@/stores/preview";

const props = defineProps<{ tab: PreviewTab }>();

/** 兜底组件不装 i18n 插件也要能渲染（测试直接 mount 本组件），故用全局实例而非 useI18n。 */
const t = i18n.global.t;

/** 浏览器态恒为 null：没有磁盘通道，按钮点了也不会有反应。 */
const path = computed(() => (isTauriRuntime() ? resolveTabDiskPath(props.tab) : null));

async function open(): Promise<void> {
  const target = path.value;
  if (!target) return;
  if (await openWithSystemApp(target)) return;
  notify({
    kind: "warning",
    key: "preview-open-external",
    title: t("fileOp.openFailed"),
    detail: t("fileOp.openFailedDetail", { path: target }),
  });
}
</script>

<template>
  <button
    v-if="path"
    type="button"
    data-testid="preview-external-fallback"
    class="shrink-0 cursor-pointer rounded-[6px] border border-line-2 bg-panel px-2.5 py-1 text-[11.5px] text-dim transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan"
    @click="open()"
  >
    {{ t("preview.common.openExternal") }}
  </button>
</template>
