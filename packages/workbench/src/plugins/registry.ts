import type { PluginManifest } from "./types";
import { defineAsyncComponent } from "vue";
import SidebarEntriesSection from "../components/sidebar/SidebarEntriesSection.vue";
import SidebarProjectsSection from "../components/sidebar/SidebarProjectsSection.vue";
import SidebarUserSection from "../components/sidebar/SidebarUserSection.vue";
import ArtifactsPane from "../components/panels/ArtifactsPane.vue";
import DiffsPane from "../components/panels/DiffsPane.vue";
import EditorPane from "../components/panels/EditorPane.vue";
import ReviewPane from "../components/panels/ReviewPane.vue";
import SourcesPane from "../components/panels/SourcesPane.vue";
import WebPreviewPane from "../components/panels/WebPreviewPane.vue";
import TerminalPane from "../components/panels/TerminalPane.vue";

/** 视图级异步分包：Cesium / maplibre / duckdb-wasm / CodeMirror 各自独立 chunk，
 * 仅在对应 mode 首次激活时加载；sidebar 与 activity 槽位保持静态保证壳层即时渲染。 */
const ChatView = defineAsyncComponent(() => import("../views/ChatView.vue"));
const AgentsView = defineAsyncComponent(() => import("../views/AgentsView.vue"));
const AnalyticsView = defineAsyncComponent(() => import("../views/AnalyticsView.vue"));
const MarketView = defineAsyncComponent(() => import("../views/MarketView.vue"));
const AutomationView = defineAsyncComponent(() => import("../views/AutomationView.vue"));
const SettingsView = defineAsyncComponent(() => import("../views/SettingsView.vue"));

/**
 * 默认清单（id "core.builtin"）：一次性贡献全部 6 个内置 mode（主舞台以 Cowork 为家，
 * 文件查看/编辑固定在右栏）、ActivityPanel 七个内置标签页与 ShellSidebar 三个槽位。
 * 新增能力 = 向 registry 追加一个 manifest 对象，不改路由与核心组件。
 */
export const coreBuiltinManifest: PluginManifest = {
  id: "core.builtin",
  name: "GreyWork 内置能力",
  version: "0.1.0",
  contributes: {
    modes: [
      { id: "chat", title: "Chat·Cowork", component: ChatView },
      { id: "agents", title: "Agents", component: AgentsView },
      { id: "analytics", title: "数据洞察", component: AnalyticsView },
      { id: "market", title: "插件市场", component: MarketView },
      { id: "automation", title: "自动化", component: AutomationView },
      { id: "settings", title: "设置", component: SettingsView },
      /* 3D 空间 / GIS 地图暂时下线（聚焦 Cowork）：SpatialView / GisView 文件保留，
         重新上线时在 modes 中追加，并同步 router 守卫（自动）与 MobileTabBar。 */
    ],
    uiRegions: [
      // ShellSidebar 槽位
      { region: "shellSidebar", id: "sidebar.entries", title: "功能入口", component: SidebarEntriesSection, order: 10 },
      { region: "shellSidebar", id: "sidebar.projects", title: "项目与线程", component: SidebarProjectsSection, order: 20 },
      { region: "shellSidebar", id: "sidebar.user", title: "用户", component: SidebarUserSection, order: 30 },
      // ActivityPanel 内置标签页（「文件」置顶：OS 式列表 → 点击进入内容）
      { region: "activityPanel", id: "activity.editor", title: "文件", component: EditorPane, order: 5 },
      { region: "activityPanel", id: "activity.diffs", title: "Diff", component: DiffsPane, order: 10 },
      { region: "activityPanel", id: "activity.web", title: "预览", component: WebPreviewPane, order: 20 },
      { region: "activityPanel", id: "activity.terminal", title: "终端", component: TerminalPane, order: 30 },
      { region: "activityPanel", id: "activity.artifacts", title: "交付物", component: ArtifactsPane, order: 40 },
      { region: "activityPanel", id: "activity.review", title: "Review", component: ReviewPane, order: 50 },
      { region: "activityPanel", id: "activity.sources", title: "Sources", component: SourcesPane, order: 60 },
    ],
  },
};
