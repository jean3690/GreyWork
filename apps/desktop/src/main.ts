import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import { createAppRouter, i18n } from "@greywork/workbench";
import "./tailwind.css";

const app = createApp(App).use(i18n).use(createPinia()).use(createAppRouter());
app.mount("#app");
// Dev-only e2e 钩子：暴露内存 FS 与事件总线，便于 Playwright 注入产物并触发预览
// （生产构建中 import.meta.env.DEV 为 false，整段被 tree-shake 移除）。
if (import.meta.env.DEV) {
  void import("@greywork/workbench").then((m) => {
    (window as unknown as Record<string, unknown>).__gw = {
      workspaceFs: m.workspaceFs,
      appEvents: m.appEvents,
    };
  });
}

// 防白屏闪烁：tauri.conf.json 配 visible:false，窗口等首帧画完再显示。
// 两个 rAF 之间留一个 nextTick，确保 Vue 首帧布局与主题 data-theme 都已落 DOM。
void (async () => {
  await nextTick();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        void getCurrentWindow()
          .show()
          .catch(() => {});
      } catch {
        // 非 Tauri 运行（浏览器预览 devUrl）：无窗口概念，忽略。
      }
    });
  });
})();
