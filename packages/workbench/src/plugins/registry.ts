import type { PluginManifest } from "./types";
import { defineAsyncComponent } from "vue";
import SidebarEntriesSection from "../components/sidebar/SidebarEntriesSection.vue";
import SidebarWorkspacesSection from "../components/sidebar/SidebarWorkspacesSection.vue";
import SidebarUserSection from "../components/sidebar/SidebarUserSection.vue";
import ArtifactsPane from "../components/panels/ArtifactsPane.vue";
import ArtifactViewer from "../components/panels/ArtifactViewer.vue";
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
const WorkspacesView = defineAsyncComponent(() => import("../views/WorkspacesView.vue"));

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
      { id: "chat", title: "nav.modes.chat", component: ChatView },
      { id: "agents", title: "nav.modes.agents", component: AgentsView },
      { id: "analytics", title: "nav.modes.analytics", component: AnalyticsView },
      { id: "market", title: "nav.modes.market", component: MarketView },
      { id: "automation", title: "nav.modes.automation", component: AutomationView },
      { id: "settings", title: "nav.modes.settings", component: SettingsView },
      { id: "workspaces", title: "nav.modes.workspaces", component: WorkspacesView },
      /* 3D 空间 / GIS 地图暂时下线（聚焦 Cowork）：SpatialView / GisView 文件保留，
         重新上线时在 modes 中追加，并同步 router 守卫（自动）与 MobileTabBar。 */
    ],
    uiRegions: [
      // ShellSidebar 槽位（title 为 i18n key，渲染处 t() 转译）
      { region: "shellSidebar", id: "sidebar.entries", title: "sidebar.entries", component: SidebarEntriesSection, order: 10 },
      { region: "shellSidebar", id: "sidebar.workspaces", title: "sidebar.workspaces", component: SidebarWorkspacesSection, order: 20 },
      { region: "shellSidebar", id: "sidebar.user", title: "sidebar.user", component: SidebarUserSection, order: 30 },
      // ActivityPanel 内置标签页（「文件」置顶：OS 式列表 → 点击进入内容）
      { region: "activityPanel", id: "activity.editor", title: "panels.file", component: EditorPane, order: 5 },
      { region: "activityPanel", id: "activity.viewer", title: "panels.viewer.title", component: ArtifactViewer, order: 8 },
      { region: "activityPanel", id: "activity.diffs", title: "panels.diffs.title", component: DiffsPane, order: 10 },
      { region: "activityPanel", id: "activity.web", title: "panels.preview.title", component: WebPreviewPane, order: 20 },
      { region: "activityPanel", id: "activity.terminal", title: "panels.terminal.title", component: TerminalPane, order: 30 },
      { region: "activityPanel", id: "activity.artifacts", title: "panels.artifacts.title", component: ArtifactsPane, order: 40 },
      { region: "activityPanel", id: "activity.review", title: "panels.review.title", component: ReviewPane, order: 50 },
      { region: "activityPanel", id: "activity.sources", title: "panels.sources.title", component: SourcesPane, order: 60 },
    ],
  },
};
