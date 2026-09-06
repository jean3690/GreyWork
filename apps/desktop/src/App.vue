<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { Shell } from "@greywork/workbench";
import { usePreviewStore } from "@greywork/workbench";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/**
 * 桌面外壳根组件。
 *
 * 拖放接线：tauri.conf.json 开了 dragDropEnabled，宿主截获 OS 拖放事件后
 * 需要由渲染端监听（HTML5 drop 在 Tauri 窗口内收不到）。落在窗口上的文件
 * 直接以 disk 源打开到预览面板 —— 文件预览工作台最自然的入口。
 * 浏览器 dev 预览没有 webview 宿主，getCurrentWebview 抛错即静默降级。
 */
const preview = usePreviewStore();
let unlistenDrop: (() => void) | undefined;

onMounted(() => {
  void (async () => {
    try {
      unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const path = event.payload.paths[0];
        if (!path) return;
        const name = path.split(/[\\/]/).pop() ?? path;
        // kindOfPath 未知扩展也归 raw（CodeMirror 兜底），永远不会「打不开」。
        preview.open(path, name, "disk");
      });
    } catch {
      // 浏览器 dev / 无 Tauri 通道：拖放不可用，静默降级。
    }
  })();
});

onBeforeUnmount(() => {
  unlistenDrop?.();
});
</script>

<template>
  <Shell />
</template>
