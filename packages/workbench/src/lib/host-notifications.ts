/**
 * 把服务端的 `host://notify` 事件落到操作系统通知。
 *
 * 宿主侧分工：Tauri 的 `HostContext::notify` 直接在 Rust 里发系统通知（`notify.rs`），事件从不
 * 进渲染端；服务端（Electron 的 sidecar / 自托管 Web）没有通知面，只能推一条 `host://notify`
 * 事件 —— 就是这里把它接上。
 *
 * 没有原生通知面的宿主（纯浏览器 / Tauri）静默跳过：宁可不打扰，也不该在页面里塞一层来路
 * 不明的横幅（那属于产品决策，不该由这次迁移顺手定下）。
 *
 * 事件是**有损**的（断线期间的丢就丢了）：通知不该在重连后补一堆旧事。发送方是自动化任务
 * 完成与 ACP 权限待裁决（见 `HostContext::notify` 的调用点）。
 */
import { onMounted, onUnmounted } from "vue";
import { HOST_NOTIFY_EVENT, hostNotify, listen, type HostNotifyPayload } from "@greywork/host-ipc";

export function useHostNotifications(): void {
  const target = hostNotify();
  if (!target) return;
  let unlisten: (() => void) | undefined;
  onMounted(() => {
    void (async () => {
      try {
        unlisten = await listen<HostNotifyPayload>(HOST_NOTIFY_EVENT, (event) => {
          const { title, body } = event.payload ?? {};
          if (typeof title !== "string" || typeof body !== "string") return;
          void target.send(title, body).catch((error: unknown) => {
            console.warn("[notify] 系统通知发送失败（已忽略）：", error);
          });
        });
      } catch {
        // 无事件通道（浏览器预览）：静默降级到「不提示」。
      }
    })();
  });
  onUnmounted(() => unlisten?.());
}
