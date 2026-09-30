/**
 * 内嵌浏览器的槽位几何与遮挡判定（纯逻辑，DOM 环境可测）。
 *
 * 坐标口径：`getBoundingClientRect()` 给的是 CSS 像素，恰好等于 Tauri 的「逻辑像素」，
 * 直接喂给 `browser_set_bounds` 即可 —— **不要**乘 `devicePixelRatio`，Tauri 内部会做
 * logical → physical 的换算，乘了在 HiDPI 屏上反而错位。量化到 0.5px 并夹到 ≥ 0，
 * 与宿主 `sanitize_rect` 同口径：两侧一致，边界抖动才不会每帧都触发一次重定位。
 */

/** 槽位矩形：窗口客户区坐标，逻辑像素。 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 读元素相对窗口客户区的矩形；收敛到 0.5px 网格并夹到 ≥ 0。 */
export function rectOf(element: HTMLElement): BrowserRect {
  const rect = element.getBoundingClientRect();
  const quantize = (value: number): number => Math.max(0, Math.round(value * 2) / 2);
  return {
    x: quantize(rect.left),
    y: quantize(rect.top),
    width: quantize(rect.width),
    height: quantize(rect.height),
  };
}

/** 两个矩形是否在容差内相等（0.5px 内视为未变，省掉一次无意义的宿主往返）。 */
export function rectEquals(a: BrowserRect, b: BrowserRect, epsilon = 0.5): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  );
}

/**
 * 常驻 DOM 的弹层容器：它们平时渲染成空壳，**有内容**才算真的有弹层。
 * （NoticeHost / WorkspaceOverlayRegions 挂在 Shell 里从不卸载，直接查选择器会永远命中。）
 */
const OVERLAY_HOSTS = ['[data-testid="notice-host"]', '[data-testid="workspace-overlay-regions"]'];

/** 挂载即弹层的东西（reka 的 portal 弹层 + 权限卡 + 各类对话框）。 */
const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  "[data-reka-popper-content-wrapper]",
  '[data-testid="permission-prompt-host"]',
].join(", ");

/**
 * 当前是否有宿主弹层打开。
 *
 * 内嵌浏览器是**原生子 webview**，永远压在主窗口 DOM 之上 —— 弹层、右键菜单、通知
 * 只要在它的矩形里，就会被它整个盖住、点不到。所以只要检测到弹层，渲染端就必须把
 * webview 藏起来。选择器是白名单式的：新增弹层组件时（尤其是 portal 到 body 的）
 * 要记得来这里补一条。
 */
export function isOverlayPresent(root: ParentNode = document): boolean {
  if (root.querySelector(OVERLAY_SELECTOR)) return true;
  for (const selector of OVERLAY_HOSTS) {
    const host = root.querySelector(selector);
    // host.children 而非 childNodes：只关心真实元素（注释 / 空白文本不算内容）。
    if (host && host.children.length > 0) return true;
  }
  return false;
}
