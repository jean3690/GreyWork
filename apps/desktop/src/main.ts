import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import { bootInstalledMarketPlugins, createAppRouter, i18n, loadHostOs } from "@greywork/workbench";
import "./tailwind.css";

/* ===== 启动基线打点 =====
 * 起点 `gw:entry` 在 index.html 的同步脚本里（入口模块解析求值之前），这里补齐后续各点，
 * 于是能得到「导航起点 → 窗口 show()」的真实分段。全程 try/catch：打点绝不能把开窗带下水。
 *
 * 为什么常开而不是 dev-only：dev server 是未打包的海量模块，量出来的数字与发布包差一个
 * 量级；而启动基线只有在**打包后**量才有意义。落地成本是一行 console.info。 */
function mark(name: string): void {
  try {
    performance.mark(`gw:${name}`);
  } catch {
    // 无 Performance API / 被策略禁用：静默跳过。
  }
}

/** 两 mark 之间的耗时（ms）。任一 mark 缺失返回 null —— 测试里直接 import 本模块就没有 gw:entry。 */
function elapsed(from: string, to: string): number | null {
  try {
    return performance.measure(`gw:${from}→${to}`, `gw:${from}`, `gw:${to}`).duration;
  } catch {
    return null;
  }
}

function fmt(ms: number | null): string {
  return ms == null ? "—" : `${Math.round(ms)}ms`;
}

/** 一条日志给出关键路径分段 + 并发的插件清单耗时（后者不占关键路径，单独标出免得误读）。 */
function reportStartup(pluginsMs: number | null): void {
  console.info(
    `[startup] 导航→窗口 show() ${fmt(elapsed("entry", "shown"))}` +
      `（模块求值+建壳 ${fmt(elapsed("entry", "mountStart"))}` +
      ` · 挂载 ${fmt(elapsed("mountStart", "mounted"))}` +
      ` · 首帧+请求显示 ${fmt(elapsed("mounted", "shown"))}）` +
      ` · 插件清单 IPC ${pluginsMs == null ? "未完成" : fmt(pluginsMs)}（并发，不占关键路径）`,
  );
}

async function bootstrap(): Promise<void> {
  mark("bootstrap");

  // 已装插件清单：与 mount **并发**发起，不再串在首帧前面。
  //
  // 以前是 `await bootInstalledMarketPlugins()` 再 mount，两个代价：一是那次读盘 IPC
  // 整个压在窗口显示之前（窗口 visible:false，等 mount + 两帧 rAF）；二是 IPC 一旦失败，
  // 这个 rejection 会打断 bootstrap —— mount 根本不执行，用户看到的是一扇永远不显示的窗。
  // 插件贡献的导航项走响应式快照，落地时会自己补上，所以先画壳、清单后到即可。
  const pluginsStart = performance.now();
  let pluginsMs: number | null = null;
  void bootInstalledMarketPlugins()
    .catch((error: unknown) => {
      console.error("[bootstrap] 已装插件清单加载失败，本次不注册市场插件", error);
    })
    .finally(() => {
      pluginsMs = performance.now() - pluginsStart;
      mark("plugins");
    });

  mark("mountStart");
  const app = createApp(App).use(i18n).use(createPinia()).use(createAppRouter());
  app.mount("#app");
  mark("mounted");

  // 宿主 OS：标题栏据此决定窗口控件放左还是放右、快捷键提示写 ⌘ 还是 Ctrl。
  // 同样**不 await** —— 取不到就按非 macOS 渲染（Windows/Linux 的既有布局），
  // 不能因为一次信息性 IPC 挡住首帧或窗口显示。
  void loadHostOs();
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
      mark("shown");
      reportStartup(pluginsMs);
    });
  });
}

void bootstrap();
