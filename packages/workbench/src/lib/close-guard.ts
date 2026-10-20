/**
 * 「有未保存改动时别退出去」的渲染端一半。
 *
 * 两条退出 / 离开路径，经 `@greywork/host-ipc` 的 `closeGuardHost()` 抹平后端差异：
 * - **点窗口 X**：`onCloseRequested` —— 关闭动作已被宿主拦下（Tauri 侧 `preventDefault`，
 *   Electron 侧主进程 `event.preventDefault`），脏不脏只有渲染端知道，所以守卫入口在这一侧。
 *   收口（隐藏 / 真关）仍回宿主：`requestClose()`。
 * - **托盘「退出应用」/ macOS Cmd+Q**：`onExitRequested` —— 绕过关窗，由宿主拦下后发事件过来；
 *   放行时调 `confirmExit()` 真正退出。
 *
 * 为什么 onCloseRequested 一侧不再自己 preventDefault：拦截语义已下沉到门面与各宿主
 * （Tauri 的 `getCurrentWindow().onCloseRequested` 必须同步 preventDefault，Electron 的
 * `close` 事件由主进程拦），渲染端只负责「决定收口」。
 *
 * 无窗口宿主（server 自托管 / browser-preview）：`closeGuardHost()` 返回 null，整体空转。
 */
import { closeGuardHost, type UnlistenFn } from "@greywork/host-ipc";
import { onUnmounted } from "vue";
import { clearDirtyPreviewTabs, hasDirtyPreviewTabs, requestLeave } from "./preview-edit-guard";

/**
 * 把「当前是否有未保存改动」同步给宿主。宿主只据此判断要不要拦退出路径。
 * 失败只记日志：这只是守卫的输入，同步不上不该影响用户正在做的事。
 */
export async function syncUnsavedChanges(unsaved: boolean): Promise<void> {
  const host = closeGuardHost();
  if (!host) return;
  try {
    await host.syncUnsavedChanges(unsaved);
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
 * 用户选「放弃并继续」时先清掉脏标记再继续 —— 否则 re-entrant 的关闭请求会看到同一份
 * 脏标记，把窗口永远关不上。
 */
export function useCloseGuard(): void {
  const host = closeGuardHost();
  if (!host) return;

  const unlisteners: UnlistenFn[] = [];
  let disposed = false;

  /** 请宿主按「关闭到托盘」偏好收口。失败单独记一条：它意味着窗口可能关不掉。 */
  const requestHostClose = async (): Promise<void> => {
    try {
      await host.requestClose();
    } catch (error: unknown) {
      console.error("[close-guard] 请求宿主关闭窗口失败，窗口可能关不掉", error);
    }
  };

  void (async () => {
    try {
      const [offClose, offExit] = await Promise.all([
        host.onCloseRequested(() => {
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
        host.onExitRequested(() => {
          requestLeave(() => {
            // 宿主侧会先清标志再退出（confirmExit），不用在这里再推一次。
            void host.confirmExit();
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
