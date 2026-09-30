/**
 * 「有未保存改动时别退出去」的渲染端一半。
 *
 * 三条退出 / 离开路径各有分工：
 * - **点窗口 X**：Tauri 的 `onCloseRequested` 能在 JS 里就地拦下（`preventDefault`），
 *   脏不脏只有这里知道，所以守卫入口在这一侧 —— 也就没有「异步把标志推给宿主时用户已经
 *   点了 X」的竞态。收口动作（隐藏 / 真关）仍回宿主，见下。
 * - **托盘菜单「退出应用」/ macOS Cmd+Q**：`app.exit` 绕过 CloseRequested，渲染端没有
 *   拦截点，只能由宿主在 `RunEvent::ExitRequested` 里拦下后发事件过来（见
 *   src-tauri/src/close_guard.rs）。宿主那份标志由本模块经 `syncUnsavedChanges` 维护。
 * - **「关闭到托盘」为真时点 X**：只是隐藏窗口，不丢数据，`hasDirtyPreviewTabs()` 为真
 *   也不该弹窗 —— 所以下面拦下后走的是「保存成功就请宿主收口」，隐藏 / 关闭的判据
 *   仍然只在宿主一处（`close_main_window` 的 `should_hide_on_close`），不在这里重写。
 *
 * **为什么这里一律 `preventDefault()`**：Tauri 只要发现 JS 注册了 `tauri://close-requested`
 * 监听，就无条件替我们 `prevent_close()`，把「真的关掉」整个甩给 JS 包装层；而包装层在
 * 没 `preventDefault` 时的默认动作是 `plugin:window|destroy` —— 那是一条独立的 ACL 命令，
 * 渲染端没被授权。依赖它的话「关闭即退出」会静默失效（点 X 什么都不发生），
 * 「关闭到托盘」则被宿主自己的 hide 掩盖、看不出问题。所以这里从不放行，收口一律走
 * `close_main_window`（宿主侧销毁不需要 ACL）。
 *
 * 浏览器态整体空转（没有 IPC 宿主）。
 */
import { isTauriRuntime } from "@greywork/core";
import { invoke, listen, type UnlistenFn } from "@greywork/host-ipc";
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
 * 请宿主按「关闭到托盘」偏好收口（隐藏或真关窗口）。
 *
 * 失败只记日志 —— 但这条失败意味着窗口关不掉（Tauri 已把关闭交给渲染端），所以单独
 * 记一条，别让它混在别的守卫日志里。
 */
async function requestHostClose(): Promise<void> {
  try {
    await invoke("close_main_window");
  } catch (error: unknown) {
    console.error("[close-guard] 请求宿主关闭窗口失败，窗口可能关不掉", error);
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
          // 一律拦下：放行等于把收口交给包装层的 destroy()，那条路没被授权（见文件头）。
          event.preventDefault();
          if (!hasDirtyPreviewTabs()) {
            void requestHostClose();
            return;
          }
          requestLeave(() => {
            clearDirtyPreviewTabs();
            void syncUnsavedChanges(false);
            void requestHostClose();
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
