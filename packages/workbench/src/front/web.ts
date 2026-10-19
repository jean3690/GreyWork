/**
 * Web 端前端集合：**一个后端、多个前端**里的示范子集。
 *
 * 取 `guid`（落地页 —— 外壳的根路径重定向指向它，不带它的前端得自己决定落到哪，
 * 见 router/index.ts）、`conversation`（本产品主界面）与 `automation`（定时任务，
 * 服务端本来就在跑，Web 端有实义）。
 *
 * 没取的几项，以及为什么：
 * - `channels`：它的 `setup` 拥有六条 IM 通道的监听注册与自动连接（见其 spec.ts）。浏览器里
 *   打开一个标签页就替用户把各条通道拨上线，是明确不该发生的事 —— 这正是「能整块删掉的差异
 *   写进静态特性集」这条准则最实的收益。
 * - `team` / `assistants`：本轮示范端不对它们做取舍。加进来是个产品判断而不是
 *   架构判断，别在这里替产品拍板。
 *
 * `plugins` 是**显式取用**的（对标 vscode.dev 的浏览器端插件体验）：插件运行时是纯前端的
 *（Cordis loader + Web Worker 沙箱 + localStorage 存档），`plugin_market_*` 五条宿主命令全部
 * `desktop:false`，浏览器连 headless 服务端时目录/预览/安装/卸载通道原生可用。无宿主的
 * 纯浏览器预览态按既有约定降级：可浏览目录、不可安装；notify / window.floating 无桌面壳
 * 即不可用（见 plugins/plugin-window.ts 与 capabilities.ts 的传输注入条件）。
 *
 * 外壳接线只留 `queueBridge` 与 `hostNotifications`：托盘与关窗守卫是桌面壳独有的宿主集成
 *（Web 端既没有托盘，也没有「点 X 关窗」这个动作，见 features/shell/wiring.ts）。注意去掉它们
 * 是**语义**上的取舍、不是修一个坏掉的东西 —— 今天桌面端在浏览器 dev 预览里就是带着四条接线
 * 跑的，所以这四条在无宿主环境下本来就安全。
 *
 * 面板（panels）暂与桌面端**完全一致**：本轮验证的是「特性集与宿主接线可以按端分叉」，
 * 外壳形态本身不动。收窄面板（例如去掉活动带/终端）动的是 `syncViewport()` 的视口语义，
 * 值得单独一处改动，不该混在这里。
 */
import type { FrontSpec } from "./types";
import { guidFeature } from "@/features/guid/spec";
import { conversationFeature } from "@/features/conversation/spec";
import { automationFeature } from "@/features/automation/spec";
import { pluginsFeature } from "@/features/plugins/spec";

export const WEB_FRONT: FrontSpec = {
  id: "web",
  label: "Web 端",
  features: [guidFeature, conversationFeature, automationFeature, pluginsFeature],
  shell: {
    panels: { sider: true, preview: true, workspace: true, activity: true, terminal: true },
    wiring: ["queueBridge", "hostNotifications"],
  },
};
