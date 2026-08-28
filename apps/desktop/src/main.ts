import { createApp } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import { createWorkbenchRouter, i18n } from "@greywork/workbench";
import "./tailwind.css";

const app = createApp(App).use(i18n).use(createPinia()).use(createWorkbenchRouter());
app.mount("#app");

// 首帧渲染后再显示窗口（tauri.conf.json 配 visible:false 防白屏闪烁）。
requestAnimationFrame(() => {
  try {
    void getCurrentWindow()
      .show()
      .catch(() => {});
  } catch {
    // 非 Tauri 运行（浏览器预览 devUrl）：无窗口概念，忽略。
  }
});
