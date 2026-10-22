/**
 * 无原生文件夹选择器时的「手输路径」弹层（命令式）。
 *
 * 为什么需要：工作区绑定要的是**服务端上的绝对路径**，而浏览器给不出本机路径
 * （`<input webkitdirectory>` 只有相对结构，自托管部署下更是另一台机器）。原实现直接
 * `window.prompt` 问一句 —— Chromium 已明确不实现 prompt（"prompt() is and will not be
 * supported."），于是自托管 Web / 浏览器态点「添加工作区」「绑定文件夹」毫无反应。
 *
 * 形状与 preview-edit-guard 的 pendingDiscard 一致：一次动作的暂存态放模块级，
 * 不进 pinia（不需要序列化，也不该跨会话）。调用方 `await requestPathInput()`，
 * 全局挂载的 PathPromptDialog 渲染输入框并 `settlePathInput()` 收口。
 */
import { ref } from "vue";

/** 是否有待回答的路径输入（外壳据此挂载弹层）。 */
export const pathPromptOpen = ref(false);

let settle: ((value: string | null) => void) | null = null;

/**
 * 请用户输入一个路径；取消返回 null。
 *
 * 重入（上一次弹层还没回答又来一次）时把前一个请求按取消收口 —— 否则那个 Promise
 * 永远悬着，调用方的 await 再也不会继续。
 */
export function requestPathInput(): Promise<string | null> {
  settle?.(null);
  return new Promise((resolve) => {
    settle = resolve;
    pathPromptOpen.value = true;
  });
}

/** 弹层收口；`value` 由弹层负责 trim，空值统一传 null。 */
export function settlePathInput(value: string | null): void {
  const resolve = settle;
  settle = null;
  pathPromptOpen.value = false;
  resolve?.(value);
}
