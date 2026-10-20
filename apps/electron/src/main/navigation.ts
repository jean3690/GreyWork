/**
 * 主窗 / 插件悬浮窗的导航硬化。
 *
 * 两扇窗都载入自家 SPA，并挂了 preload（`__GREYWORK_SHELL__` 暴露剪贴板、打开路径、托盘等
 * 宿主能力）。一旦页面被导航到远端地址，远端内容就继承了这份桥 —— 所以：
 *
 * - **只放行同源导航**，其余 `will-navigate` 直接拦下；
 * - **不开新窗**（`window.open` / target=_blank 一律 deny），http(s) 交给系统浏览器；
 * - **拒绝 webview 挂载**（渲染层不需要 `<webview>`，留着就是额外攻击面）。
 */
import { shell, type WebContents } from "electron";

import { isExternalHttpUrl, isSameOrigin } from "../shared/navigation";

/** 把导航规则装到指定 webContents 上（主窗与插件悬浮窗共用）。 */
export function guardNavigation(contents: WebContents, origin: string): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isSameOrigin(url, origin)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) void shell.openExternal(url);
  });

  contents.on("will-attach-webview", (event) => event.preventDefault());
}
