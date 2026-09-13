import type { CapabilityGrantSpec } from "./capabilities";

export interface PluginRegistry {
  schemaVersion: 1;
  plugins: PluginRegistryEntry[];
}

export interface PluginRegistryEntry {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  downloadUrl: string;
  sha256: string;
}

export interface PluginPackage {
  schemaVersion: 1;
  manifest: MarketPluginManifest;
}

/** 安装态由宿主附带已校验的代码；远端 package JSON 不包含该字段。 */
export interface InstalledPluginPackage extends PluginPackage {
  code?: string;
}

export interface CodePluginRuntime {
  type: "worker";
  entry: string;
  sha256: string;
  /** 可选渲染循环：worker 暴露该 handler，宿主按 fps 轮询拉取绘图指令。 */
  render?: {
    handler: string;
    fps?: number;
    width?: number;
    height?: number;
  };
}

export interface PluginWindowDecl {
  width: number;
  height: number;
}

export interface MarketPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 缺省保持 v1 声明式包兼容；worker 包必须提供 runtime。 */
  kind?: "declarative" | "worker";
  runtime?: CodePluginRuntime;
  /** 字符串或 { capability, hosts } 对象；安装期 Rust 侧校验形态。 */
  requires: CapabilityGrantSpec[];
  /** 可选脱窗声明（window.floating 能力配套）：宿主开透明置顶窗渲染该包画布。 */
  window?: PluginWindowDecl;
  contributes: {
    modes: DeclarativeMode[];
    /**
     * 区域贡献（v2）：worker 包可把自己的渲染循环挂到宿主的既有区域
     * （shellSidebar / activityPanel / workspaceOverlay），让插件常驻而非只在模式页里。
     * 内容 = runtime.render 的 handler 指令流 + 可选动作按钮；无 Vue 代码。
     */
    uiRegions?: MarketUiRegionContribution[];
  };
}

export interface MarketUiRegionContribution {
  /** 宿主区域：左侧栏分组 / 底部活动面板页签。 */
  region: "shellSidebar" | "activityPanel" | "workspaceOverlay";
  /** 区域内唯一；兼作持久化激活键。 */
  id: string;
  /** 分组/页签标题。 */
  title: string;
  order?: number;
  /** 仅 activityPanel：收进「更多」下拉。 */
  overflow?: boolean;
  /** 画布尺寸（可选，缺省用 runtime.render 的）。 */
  width?: number;
  height?: number;
  /** 可选动作按钮（≤4 个）：点击 → worker handler(state) → patch 合并进区域状态。 */
  actions?: Array<{ id: string; label: string }>;
}

export interface DeclarativeMode {
  id: string;
  title: string;
  icon?: string;
  page: DeclarativePage;
}
export type DeclarativeValue = string | number | boolean;

export interface DeclarativeField {
  key: string;
  label: string;
  description?: string;
  kind: "text" | "number" | "toggle";
  default: DeclarativeValue;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
}

export interface DeclarativeOutput {
  label: string;
  valueKey: string;
  suffix?: string;
}

export type DeclarativeOperation =
  | { type: "increment"; key: string; amount?: number }
  | { type: "set"; key: string; value: DeclarativeValue }
  | { type: "reset" }
  | { type: "invoke"; handler: string };

export interface DeclarativeAction {
  id: string;
  label: string;
  style?: "primary" | "secondary" | "danger";
  operation: DeclarativeOperation;
}

export interface DeclarativePage {
  eyebrow?: string;
  heading: string;
  body: string;
  /** 旧版单计数器包；新包应使用 fields / outputs / actions。 */
  counterLabel?: string;
  fields?: DeclarativeField[];
  outputs?: DeclarativeOutput[];
  actions?: DeclarativeAction[];
}

export interface PluginInstallReport {
  id: string;
  version: string;
  path: string;
}
