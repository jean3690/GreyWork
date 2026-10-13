<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import { AuthGate, Shell } from "@greywork/workbench";
import { isPhysicalPointInDropzone, usePreviewStore } from "@greywork/workbench";
import { authorizeDroppedPaths, hostApp, hostDragDrop, type HostDragDrop } from "@greywork/host-ipc";

/**
 * 桌面外壳根组件的「落到窗口上的文件 → 开预览」接线（输入卡上的拖放由输入卡自己收编为附件，
 * 这里先让位，`data-attachment-dropzone` 命中即跳过，否则一次拖放会同时贴附件又开预览）。
 *
 * 两条路按宿主分叉：
 * - **原生拖放面存在**（Tauri 开了 dragDropEnabled：OS 拖放被宿主截获、HTML5 drop 在窗口内
 *   收不到）：监听宿主的原生拖放事件，用物理坐标判定是否落在输入卡上。
 * - **原生拖放面不存在**（Electron / 浏览器：OS 拖放以标准 HTML5 drop 抵达 DOM）：Electron
 *   能经 `webUtils` 从 File 取磁盘绝对路径开 disk 预览，浏览器态拿不到路径则不开（静默）。
 *
 * 拖放只给路径、不给字节流，所以两条路都要先让宿主把路径纳入授权账本 —— 见
 * `openPathInPreview`。
 */
const preview = usePreviewStore();
let unlistenDrop: (() => void) | undefined;
let cleanupWebDrop: (() => void) | undefined;

async function openPathInPreview(path: string): Promise<void> {
  // Tauri 壳在 Rust 的 Drop 分支里已授权（空操作）；Electron / 自托管服务端下宿主不知道
  // 用户拖过什么，必须显式声明，否则随后读盘会以「路径未获用户授权」拒绝。
  await authorizeDroppedPaths([path]);
  const name = path.split(/[\\/]/).pop() ?? path;
  // kindOfPath 未知扩展也归 raw（CodeMirror 兜底），永远不会「打不开」。
  preview.open(path, name, "disk");
}

function mountNativeDrop(drop: HostDragDrop): void {
  void (async () => {
    try {
      unlistenDrop = await drop.onDragDrop((payload) => {
        if (payload.type !== "drop") return;
        void (async () => {
          if (await isPhysicalPointInDropzone(payload.position)) return;
          const path = payload.paths[0];
          if (path) void openPathInPreview(path);
        })();
      });
    } catch {
      // 无原生拖放通道：静默降级到 HTML5。
    }
  })();
}

function mountWebDrop(): void {
  const native = hostApp();
  const onDragOver = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  };
  const onDrop = (event: DragEvent): void => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("[data-attachment-dropzone]")) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const path = native?.pathForDroppedFile(file) ?? null;
    if (!path) return; // 浏览器态拿不到磁盘路径：不开 disk 预览
    event.preventDefault();
    void openPathInPreview(path);
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  cleanupWebDrop = () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
  };
}

onMounted(() => {
  const drop = hostDragDrop();
  if (drop) mountNativeDrop(drop);
  else mountWebDrop();
});

onBeforeUnmount(() => {
  unlistenDrop?.();
  cleanupWebDrop?.();
});
</script>

<template>
  <!-- 登录门包住整个 Shell：服务端态未认证时它只渲染登录表单，Shell 根本不挂载，
       也就不会先发出一批必然 401 的命令。桌面/浏览器预览态它直接透传。 -->
  <AuthGate>
    <Shell />
  </AuthGate>
</template>
