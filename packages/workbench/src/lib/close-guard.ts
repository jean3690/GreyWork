/**
 * 「有未保存改动时别退出去」的渲染端一半。
 *
 * 三条退出 / 离开路径各有分工：
 * - **点窗口 X**：Tauri 的 `onCloseRequested` 能在 JS 里就地拦下（`preventDefault`），
 *   直接在这里走守卫，不需要宿主参与 —— 也就没有「异步把标志推给宿主时用户已经点了 X」
 *   的竞态。
 * - **托盘菜单「退出应用」/ macOS Cmd+Q**：`app.exit` 绕过 CloseRequested，渲染端没有
 *   拦截点，只能由宿主在 `RunEvent::ExitRequested` 里拦下后发事件过来（见
 *   src-tauri/src/close_guard.rs）。宿主那份标志由本模块经 `syncUnsavedChanges` 维护。
 * - **「关闭到托盘」为真时点 X**：只是隐藏窗口，不丢数据，`hasDirtyPreviewTabs()` 为真
 *   也不该弹窗 —— 所以下面拦下后走的是「保存成功就 `close()`」，而 `close()` 会再走一遍
 *   宿主的 CloseRequested 分支，隐藏 / 关闭交给它决定，不在这里重写一遍策略。
 *
 * 浏览器态整体空转（没有 IPC 宿主）。
 */
import { isTauriRuntime } from "@greywork/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onUnmounted } from "vue";
import { clearDirtyPreviewTabs, hasDirtyPreviewTabs, requestLeave } from "./preview-edit-guard";

/** 与 src-tauri/src/close_guard.rs 的事件名常量同名 —— 改一边必须改另一边。 */
const EVENT_EXIT_REQUESTED = "close-guard:exit-requested";

/**
 * 把「当前是否有未保存改动」同步给宿主。宿主只据此判断要不要拦 `ExitRequested`。
 * 失败只记日志：这只是守卫的输入，同步不上不该影响用户正在做的事。
 */
export async function syncUnsavedChanges(unsaved: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_unsaved_changes", { unsaved });
  } catch (error: unknown) {
    console.error("[close-guard] 同步未保存标记失败", error);
  }
}

/**
 * 订阅「关窗 / 退出」两条路径，返回解绑函数。
 *
 * 在外壳（Shell.vue）里调用 —— 它是窗口级 / 应用级接线，和托盘桥同一性质。
 * 确认弹层不在这里渲染：`pendingDiscard` 由 PreviewSider 渲染（它持有 saver 注册表，
 * 也知道怎么列失败的文件名）。
 *
 * 拦下的动作都交给 `requestLeave`：先自动保存，全成功才真的走；写不进去才弹确认。
 * 用户选「放弃并继续」时先清掉脏标记再继续 —— 否则 re-entrant 的 CloseRequested
 * 会看到同一份脏标记，把窗口永远关不上。
 */
export function useCloseGuard(): void {
  if (!isTauriRuntime()) return;

  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  void (async () => {
    try {
      const appWindow = getCurrentWindow();
      const [offClose, offExit] = await Promise.all([
        appWindow.onCloseRequested((event) => {
          if (!hasDirtyPreviewTabs()) return;
          event.preventDefault();
          requestLeave(() => {
            clearDirtyPreviewTabs();
            void syncUnsavedChanges(false);
            void appWindow.close();
          });
        }),
        listen(EVENT_EXIT_REQUESTED, () => {
          requestLeave(() => {
            // 宿主侧会先清标志再退出（confirm_exit），不用在这里再推一次。
            void invoke("confirm_exit");
          });
        }),
      ]);
      if (disposed) {
        offClose();
        offExit();
        return;
      }
      unlisteners.push(offClose, offExit);
    } catch (error: unknown) {
      console.error("[close-guard] 订阅关闭 / 退出事件失败", error);
    }
  })();

  onUnmounted(() => {
    disposed = true;
    for (const off of unlisteners) off();
    unlisteners.length = 0;
  });
}
