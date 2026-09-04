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
export function usePreviewBridge(): void {
  const preview = usePreviewStore();

  const disposers = [
    appEvents.on("artifact:created", ({ path, name }) => preview.open(path, name)),
    appEvents.on("artifact:updated", ({ path }) => preview.reload(path)),
    appEvents.on("preview:request", ({ path }) => preview.open(path)),
    appEvents.on("editor:open", ({ path }) => preview.open(path)),
  ];

  onUnmounted(() => {
    for (const dispose of disposers) dispose();
  });
}
