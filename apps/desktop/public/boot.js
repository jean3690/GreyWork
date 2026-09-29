/*
 * 首帧引导：必须作为**经典脚本**同步执行（模块脚本一律 deferred，等它跑完主题 CSS
 * 已经解析完，浅色用户会先闪一帧深色；Tauri 的 `visible:false` 只挡住桌面端，
 * 浏览器态没有这道闸）。
 *
 * 为什么是外部文件而不是内联：自托管服务端与桌面壳的 CSP 都不含 `'unsafe-inline'`，
 * 内联脚本会被 `script-src` 直接拦下（一条 `script-src-elem` 违规）。走同源外链则落在
 * `script-src 'self'` 里 —— 两个宿主都不用为了首帧外观放宽策略。
 *
 * 只做两件事，都不碰业务状态：
 * 1. 读 localStorage → 写 `<html>` 的四个 `data-*`；stores/settings.ts 的 applySaved()
 *    随后用同一份快照接管，两者的取值口径与默认值必须同步改。
 * 2. `performance.mark("gw:entry")` —— 在入口模块求值之前打点，让 main.ts 的启动日志
 *    覆盖真实的「导航起点 → 窗口 show()」全过程。
 */
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem("greywork.settings") || "{}");
    var palette = ["greywork", "night-blue", "night-green", "github", "fox"].indexOf(saved.theme) >= 0 ? saved.theme : "greywork";
    // v0.1 兼容：旧快照把明暗存在 theme 上，口径与 stores/settings.ts 的 applySaved 一致。
    var mode =
      ["dark", "light", "system"].indexOf(saved.colorMode) >= 0
        ? saved.colorMode
        : ["dark", "light", "system"].indexOf(saved.theme) >= 0
          ? saved.theme
          : "dark";
    if (mode === "system") {
      mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    var fontSize = ["small", "medium", "large"].indexOf(saved.fontSize) >= 0 ? saved.fontSize : "medium";
    var radius = ["none", "small", "large"].indexOf(saved.radius) >= 0 ? saved.radius : "small";
    var root = document.documentElement;
    root.dataset.palette = palette;
    root.dataset.theme = mode;
    root.dataset.fontSize = fontSize;
    root.dataset.radius = radius;
  } catch (error) {
    /* 存储被禁用 / 快照损坏：保持下面的默认深色，不阻塞启动。 */
  }

  try {
    performance.mark("gw:entry");
  } catch (error) {
    /* 无 Performance API：main.ts 会退化为「—」，不阻塞启动。 */
  }
})();
