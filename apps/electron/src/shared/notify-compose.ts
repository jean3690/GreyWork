/**
 * 插件通知的文案组装（纯函数：脱开 Electron 也能单测）。
 *
 * 标题要加 `[pluginId] ` 归属前缀，**前缀由宿主加、插件伪造不了** —— 与 Rust 侧
 * `greywork_host::plugin_market::compose_plugin_notify` 的可观测行为对齐。
 *
 * 长度（标题 64 / 正文 240）与控制字符校验在渲染端 `capabilities.ts` 已先做过；这里只补归属
 * 前缀 + 最小非空校验，避免把 Rust 侧的常量在 TS 里再抄一遍（两处漂移比少一层防御更糟）。
 */
export interface PluginNotifyRequest {
  pluginId: string;
  title: string;
  body: string;
}

export function composePluginNotify(request: PluginNotifyRequest): { title: string; body: string } {
  const title = request.title.trim();
  const body = request.body.trim();
  if (!request.pluginId) throw new Error("notify pluginId must not be empty");
  if (!title) throw new Error("notify title must not be empty");
  if (!body) throw new Error("notify body must not be empty");
  return { title: `[${request.pluginId}] ${title}`, body };
}
