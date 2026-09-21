/**
 * 输入框（textarea）右键菜单的四个动作：剪切 / 复制 / 粘贴 / 全选。
 *
 * 为什么要自己实现：reka 的 ContextMenuTrigger 会 preventDefault 掉原生右键菜单
 * （见 lib/context-menu.ts 顶部），原生那套编辑动作不会出现，只能由我们补上。
 *
 * - 写剪贴板复用 lib/clipboard 的 copyText（全仓唯一写入入口）。
 * - 读剪贴板走 clipboard-manager 插件：WKWebView / WebKitGTK 上 navigator.clipboard
 *   不可靠（同 clipboard.ts 顶部注释），桌面必须走插件；浏览器态反过来走 Web API。
 * - 插入用 setRangeText + 派发 input：v-model 监听的是 input 事件，只改 DOM 不派发
 *   会让视图与草稿脱节。
 */
import { isTauriRuntime } from "@greywork/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { copyText } from "./clipboard";
import { i18n } from "../i18n";
import { notify } from "../stores/notice";

interface Selection {
  start: number;
  end: number;
  text: string;
}

function selectionOf(el: HTMLTextAreaElement): Selection {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  return { start, end, text: el.value.slice(start, end) };
}

/** 是否有选区：无选区时「剪切 / 复制」置灰（与原生菜单一致）。 */
export function hasTextSelection(el: HTMLTextAreaElement | null): boolean {
  if (!el) return false;
  const { start, end } = selectionOf(el);
  return end > start;
}

/** 用 text 替换 [start, end)，并派发 input 让 v-model 拿到新值。 */
function replaceRange(el: HTMLTextAreaElement, text: string, start: number, end: number): void {
  if (typeof el.setRangeText === "function") {
    el.setRangeText(text, start, end, "end");
  } else {
    // 老引擎兜底：手动拼值并把光标落到插入末尾。
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function copySelection(el: HTMLTextAreaElement | null): Promise<void> {
  if (!el) return;
  const { text } = selectionOf(el);
  if (text) await copyText(text);
}

export async function cutSelection(el: HTMLTextAreaElement | null): Promise<void> {
  if (!el) return;
  const { start, end, text } = selectionOf(el);
  if (!text) return;
  await copyText(text);
  replaceRange(el, "", start, end);
}

/** 读系统剪贴板文本：桌面走插件（可靠），浏览器态走 Web API（插件必然失败）。 */
async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) return await readText();
  // eslint-disable-next-line no-restricted-properties -- 浏览器态没有 IPC 宿主，按运行时分叉
  return await navigator.clipboard.readText();
}

export async function pasteInto(el: HTMLTextAreaElement | null): Promise<void> {
  if (!el) return;
  let text: string;
  try {
    text = await readClipboardText();
  } catch (error: unknown) {
    // 系统剪贴板里是图片、或宿主没给读文本权限：不静默失败，提示改用键盘。
    console.error("[composer] 读取剪贴板文本失败", error);
    notify({ kind: "warning", key: "composer-paste", title: i18n.global.t("contextMenu.composer.pasteFailed") });
    return;
  }
  if (!text) return;
  const { start, end } = selectionOf(el);
  replaceRange(el, text, start, end);
}

export function selectAllText(el: HTMLTextAreaElement | null): void {
  el?.select();
}
