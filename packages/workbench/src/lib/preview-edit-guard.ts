/**
 * 预览编辑的「离开前先保存」守卫。
 *
 * **为什么需要它**：可编辑预览（xlsx / docx / pptx / 文本）的编辑器实例在卸载时注销 saver
 * （见 lib/preview-save.ts），而这几条路径都会卸载它 —— 区段切换（文件 / 变更）、切换标签、
 * 关闭标签、关闭窗口。此前只有「关闭标签」有确认，其余三处都是静默丢改动。
 *
 * **策略**：离开前自动保存，全部成功才继续；只有保存失败才弹确认（放弃并继续 / 取消）。
 * 所以这里不预先问「你确定要放弃吗」—— 正常路径无需用户点头，只在真的写不进去时
 * 把选择权交回用户，避免「以为存住了」这种最坏的结局。
 *
 * `pendingDiscard` 放模块级而不是塞进 pinia：与 preview-save.ts 的 saver 注册表同一理由 ——
 * 它是一次「离开动作」的暂存态，不是需要序列化 / 跨会话的持久状态，组件卸载也不该清掉它
 * （弹层正是由卸载它的那次操作触发的）。
 */
import { ref } from "vue";
import { notify } from "../stores/notice";
import { usePreviewStore, type PreviewTab } from "../stores/preview";
import { isPreviewDirty, previewSaver } from "./preview-save";

/** 保存失败、等用户决定是否放弃的那次离开动作。`run` 是「继续离开」要做的事。 */
export interface PendingDiscard {
  run: () => void;
  failed: PreviewTab[];
}

/** 待用户决定的离开动作；null = 无弹层。 */
export const pendingDiscard = ref<PendingDiscard | null>(null);

/** 当前有未保存改动的 tab（saver 已注册且 dirty）。 */
export function dirtyPreviewTabs(): PreviewTab[] {
  return usePreviewStore().tabs.filter((tab) => isPreviewDirty(tab.id));
}

/** 关窗守卫的判据：是否有任何未保存改动。 */
export function hasDirtyPreviewTabs(): boolean {
  return dirtyPreviewTabs().length > 0;
}

/**
 * 逐个保存所有脏 tab，返回保存失败的 tab。
 *
 * 按 tab.id 现取 saver：脏标记由编辑器自己持有，这里只读。
 * 单个失败不中断其余（一个坏文件不该连累另一个能存的文件）。
 */
export async function flushDirtyPreviewTabs(): Promise<PreviewTab[]> {
  const failed: PreviewTab[] = [];
  for (const tab of dirtyPreviewTabs()) {
    const saver = previewSaver(tab.id);
    if (!saver || !saver.dirty.value) continue;
    try {
      await saver.save();
      // 自动保存是用户没显式要求写盘的动作，必须给一条回执，否则改动「悄悄没了」和
      // 「悄悄存了」在界面上无法区分。同 key 就地替换，连续切换不会叠一串通知。
      notify({ kind: "success", key: "preview-save", title: "已保存", detail: tab.name });
    } catch {
      failed.push(tab);
    }
  }
  return failed;
}

/**
 * 离开某个编辑上下文（切区段 / 切标签 / 关标签 / 关窗）前的守卫。
 *
 * **无脏改动时同步执行 `run`**：绝大多数离开都发生在没有编辑的时候，让它们多跳一个
 * 微任务毫无意义（也让既有调用方与测试不必改成 await）。只有真有脏改动才异步保存，
 * 保存全成功即执行 `run`，有失败则记下 `run` 并弹确认。
 * 已有待确认弹层时忽略后续请求：否则连续点击会叠出多个「继续离开」。
 */
export function requestLeave(run: () => void): void {
  if (pendingDiscard.value) return;
  if (!hasDirtyPreviewTabs()) {
    run();
    return;
  }
  void (async () => {
    const failed = await flushDirtyPreviewTabs();
    if (!failed.length) {
      run();
      return;
    }
    pendingDiscard.value = { run, failed };
  })();
}

/** 用户选择「放弃并继续」：执行被暂存的离开动作。 */
export function confirmDiscard(): void {
  const pending = pendingDiscard.value;
  pendingDiscard.value = null;
  pending?.run();
}

/** 用户选择「取消」：留在原地，改动仍在编辑器里。 */
export function cancelDiscard(): void {
  pendingDiscard.value = null;
}

/**
 * 用户选择「放弃」时把脏标记抹掉。
 *
 * 关窗那条路必须用：`close()` 之后宿主 / Tauri 会再走一遍 CloseRequested，而编辑器要到
 * 卸载才注销 saver（更晚），不清标记就会看到同一份脏、再次拦下 —— 窗口永远关不上。
 * 标记抹掉不等于内容丢了：调用方紧接着就会卸载编辑器，本来就要丢。
 */
export function clearDirtyPreviewTabs(): void {
  for (const tab of dirtyPreviewTabs()) {
    const saver = previewSaver(tab.id);
    if (saver) saver.dirty.value = false;
  }
}
