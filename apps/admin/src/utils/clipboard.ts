/**
 * 复制文本。
 *
 * 不用 navigator.clipboard：本仓 ESLint 全局禁用该属性（桌面 WebView 上会静默
 * resolve 但不写入），运维台虽然是浏览器页面，也沿用同一条规则，免得以后被搬进
 * 桌面壳时才发现剪贴板是坏的。execCommand 在 http://localhost 与 https 下都可用。
 */
export function copyText(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok: boolean;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}
