import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import { initRuntimeMode } from "@greywork/host-ipc";
import App from "./App.vue";
import {
  WEB_FRONT,
  bootInstalledMarketPlugins,
  createAppRouter,
  i18n,
  initDeviceTier,
  loadHostSystem,
  setFront,
} from "@greywork/workbench";
// Tailwind 入口是**全仓共享**的那一份（主题令牌只此一处，见 workbench/src/tailwind.css）。
import "@greywork/workbench/tailwind.css";

/**
 * Web 端入口：`apps/desktop/src/main.ts` 的瘦身版。
 *
 * 与桌面端的差别都是**有意的**，不是抄漏了：
 * - **没有「藏窗口再显示」那一段**。桌面端以 visible:false 起手、等首帧画完再
 *   `hostWindow().show()`，为的是防白屏闪烁；浏览器里没有窗口可藏，整段不适用。这里只把
 *   打点补到首帧。
 * - **市场插件引导与 mount 并发，且必须排在 `initRuntimeMode()` 之后**。桌面端把这条 IPC
 *   排在判定之前无碍（Electron 壳下怎么探都是 server 态）；本端不 await 就起飞会恒判
 *   browser-preview，清单永远不拉。注册是纯追加、导航项走响应式快照，晚落地自己补上
 *   （runtime 在 boot 前后两条路径都会按启停存档激活已注册插件，见 plugins/runtime.ts）。
 * - **不挂拖放接线**（在 App.vue 里）：见那边的说明。
 */

/** 启动打点。全程 try/catch：打点绝不能把启动带下水。 */
function mark(name: string): void {
  try {
    performance.mark(`gw:${name}`);
  } catch {
    // 无 Performance API / 被策略禁用：静默跳过。
  }
}

/** 两 mark 之间的耗时（ms）。任一 mark 缺失返回 null（测试里直接 import 本模块就没有 gw:entry）。 */
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

/**
 * 一条日志给出关键路径分段。起点 `gw:entry` 在 index.html 的同步脚本里（入口模块求值之前）。
 *
 * 为什么常开而不是 dev-only：dev server 是未打包的海量模块，量出来的数字与发布包差一个
 * 量级；启动基线只有在**打包后**量才有意义。落地成本是一行 console.info。
 */
function reportStartup(): void {
  console.info(
    `[startup] 导航→首帧 ${fmt(elapsed("entry", "painted"))}` +
      `（模块求值+建壳 ${fmt(elapsed("entry", "mountStart"))}` +
      ` · 挂载 ${fmt(elapsed("mountStart", "mounted"))}` +
      ` · 首帧 ${fmt(elapsed("mounted", "painted"))}）`,
  );
}

async function bootstrap(): Promise<void> {
  mark("bootstrap");

  // 设备分级：必须在 mount 之前同步落地 —— 首帧的动效与虚拟列表参数就该按真实档位渲染，
  // 晚一帧等于低端机上白跑一遍 standard 的开销（见 lib/device-tier.ts）。
  initDeviceTier();

  // 运行时判定：必须在 mount 之前落地 —— AuthGate 与各处守卫都同步读 runtimeMode()，
  // 探测结果晚一步写下来，服务端态就会被误判成 browser-preview（登录门不弹、能力全禁）。
  await initRuntimeMode();

  // 已装插件清单：与 mount **并发**发起，压在运行时判定之后 —— 本端的 server 态是探测出来的，
  // 判定前起飞会恒判 browser-preview、清单永远不拉。失败只记日志，绝不挡启动。
  void bootInstalledMarketPlugins().catch((error: unknown) => {
    console.error("[bootstrap] 已装插件清单加载失败，本次不注册市场插件", error);
  });

  mark("mountStart");
  // 前端身份必须在 mount 之前落地：路由表与外壳接线都在 setup / mount 期同步读它。
  // Web 端**显式**声明自己那一份，不吃 `currentFront()` 的缺省 —— 理由同桌面端（见
  // front/all.ts）：缺省服务于「不关心是哪一端」的测试与无参调用，生产入口搭它的便车，
  // 等于把「缺省恰好等于本端」变成一个没人写下来的约定。
  setFront(WEB_FRONT);
  const app = createApp(App).use(i18n).use(createPinia()).use(createAppRouter());
  app.mount("#app");
  mark("mounted");

  // 宿主 OS：非原生壳下 hasNativeShell() 为 false，这里是零 I/O 的空转（见 lib/host-platform.ts）。
  // 留着而不是删掉，是为了让「浏览器里的 Web 端」与「被原生壳加载的 Web 端」走同一条启动路径。
  // 同样**不 await** —— 它是信息性的，不该挡首帧。
  void loadHostSystem();

  // Dev-only e2e 钩子：暴露内存 FS 与事件总线，便于 Playwright 注入产物并触发预览
  //（生产构建中 import.meta.env.DEV 为 false，整段被 tree-shake 移除）。
  if (import.meta.env.DEV) {
    void import("@greywork/workbench").then((m) => {
      (window as unknown as Record<string, unknown>).__gw = {
        workspaceFs: m.workspaceFs,
        appEvents: m.appEvents,
      };
    });
  }

  // 首帧收尾：两个 rAF 之间留一个 nextTick，确保 Vue 首帧布局与主题 data-theme 都已落 DOM。
  await nextTick();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mark("painted");
      reportStartup();
    });
  });
}

void bootstrap();
