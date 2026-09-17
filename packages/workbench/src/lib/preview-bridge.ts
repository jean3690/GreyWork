import { onUnmounted } from "vue";
import { appEvents } from "../events";
import { usePreviewStore } from "../stores/preview";

/**
 * 把应用事件总线接到预览面板。
 *
 * 为什么不放在 store 的 setup 里：`appEvents` 是模块级单例，而 store 每个 pinia 实例
 * 都会重建。在 store setup 里 on() 会让每个测试都往同一个 bus 上再挂一份监听，
 * 用例之间互相触发。放在组件作用域里则天然随卸载解绑。
 *
 * 四个事件的语义差别是刻意的：
 * - `artifact:created` / `preview:request` / `editor:open` → 打开并聚焦（用户/管线刚产出东西，该看见）
 * - `artifact:updated` → 只在**已打开**该路径时自增 revision 重载，不弹面板
 *   （后台给某张表追加一行不该抢走用户正在看的东西）
 */
type PreviewStore = ReturnType<typeof usePreviewStore>;

/** 挂上全部事件监听，返回解绑函数列表。供组件作用域与 store 级测试共用同一份映射。 */
export function wirePreviewBridge(preview: PreviewStore): Array<() => void> {
  return [
    appEvents.on("artifact:created", ({ path, name, diskPath }) => {
      preview.open(path, name);
      if (diskPath) preview.attachDiskPath(path, diskPath);
    }),
    appEvents.on("artifact:updated", ({ path, diskPath }) => {
      preview.reload(path);
      if (diskPath) preview.attachDiskPath(path, diskPath);
    }),
    appEvents.on("preview:request", ({ path, name, source, diskPath }) => {
      preview.open(path, name, source ?? "vfs");
      if (diskPath) preview.attachDiskPath(path, diskPath);
    }),
    appEvents.on("editor:open", ({ path }) => preview.open(path)),
  ];
}

export function usePreviewBridge(): void {
  const disposers = wirePreviewBridge(usePreviewStore());

  onUnmounted(() => {
    for (const dispose of disposers) dispose();
  });
}
