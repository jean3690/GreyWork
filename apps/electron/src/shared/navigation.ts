/**
 * 渲染端 origin 的判定规则（主进程与单测共用，不引 electron）。
 *
 * 主窗 / 插件悬浮窗载入的都是自家 SPA：**只允许同源导航**。其它 URL 一律拦下，
 * http(s) 的交给系统浏览器 —— 否则远端页面会继承 preload 暴露的宿主能力。
 */

/** 解析 URL；非法输入返回 null（不抛）。 */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** 是否为可交给系统浏览器打开的 http(s) 链接。 */
export function isExternalHttpUrl(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:");
}

/** 两个 URL 是否同源（协议 + 主机 + 端口）。非法输入一律 false。 */
export function isSameOrigin(value: string, origin: string): boolean {
  const left = parseUrl(value);
  const right = parseUrl(origin);
  return left !== null && right !== null && left.origin === right.origin;
}
