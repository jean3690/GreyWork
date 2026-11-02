import { reactive } from "vue";

/**
 * 插件状态栏文案的宿主存储：`pluginId + id` → 最近一次 `greywork.setStatus` 的文本。
 *
 * 为什么要单独存：状态栏在**外壳**里（不随插件页卸载），而 worker 只在插件页存活时才会
 * 发更新。所以文本落在宿主的模块级响应式表里，页面卸载也不丢；插件停用时外壳本来就不渲染
 * 它的条目，无需额外清理（重新启用后显示的还是最后一条状态，符合「上次成功」的语义）。
 */

/** 单条状态文案上限：底部细栏放不下一段话，也没必要。 */
const MAX_STATUS_CHARS = 80;

const texts = reactive<Record<string, string>>({});

/** 控制字符会把细栏撑开或伪造分隔，统一换成空格（不用正则，避免 no-control-regex）。 */
function sanitize(raw: string): string {
  const replaced = [...raw].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? " " : ch)).join("");
  return replaced.trim().slice(0, MAX_STATUS_CHARS);
}

export function setPluginStatus(pluginId: string, id: string, text: unknown): void {
  if (typeof text !== "string") return;
  const clean = sanitize(text);
  const key = `${pluginId}:${id}`;
  if (!clean) {
    delete texts[key];
    return;
  }
  texts[key] = clean;
}

/** 当前展示的文案；没有更新过返回 undefined（调用方回落到 manifest 的初始 label）。 */
export function pluginStatusText(pluginId: string, id: string): string | undefined {
  return texts[`${pluginId}:${id}`];
}

/** 测试钩子：清空内存态。 */
export function resetPluginStatusForTest(): void {
  for (const key of Object.keys(texts)) delete texts[key];
}
