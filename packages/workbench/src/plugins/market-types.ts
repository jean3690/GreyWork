import type { CapabilityGrantSpec } from "./capabilities";

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
    /**
     * 指针回传（缺省 false）：声明 true 时宿主把画布指针事件交给 worker 的
     * `registerPointer` 处理器，返回的状态补丁并入同一份渲染状态。
     */
    pointer?: boolean;
  };
}

export interface PluginWindowDecl {
  width: number;
  height: number;
  /** 窗口标题（缺省用 manifest.name）；宿主侧还会再夹一次长度与控制字符。 */
  title?: string;
  /** 初始是否置顶（缺省 true）；窗口内可再切换。 */
  alwaysOnTop?: boolean;
  /** 不透明度 0.2-1（缺省 1）。 */
  opacity?: number;
  /** 是否允许多开（缺省 false，最多 4 个实例）。 */
  multiple?: boolean;
}

/** 命令面板条目（v2）：只做导航，目标页由 mode 指定（缺省第一个 mode）。 */
export interface PluginCommandDecl {
  id: string;
  title: string;
  description?: string;
  mode?: string;
}

/** 键盘快捷键（v2）：全局按键，命中后打开本包页面。 */
export interface PluginKeybindingDecl {
  id: string;
  key: string;
  mode?: string;
}

/** 状态栏条目（v2）：底部细栏里的一条常驻文案。 */
export interface PluginStatusBarDecl {
  id: string;
  label: string;
  mode?: string;
}

/** 右键菜单条目（v2）：在宿主既有右键菜单里追加「打开插件」，只做导航。 */
export interface PluginContextMenuDecl {
  id: string;
  label: string;
  /** fileTree / preview / conversation（安装期已按白名单校验）。 */
  targets: string[];
  mode?: string;
}

export interface MarketPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 缺省保持 v1 声明式包兼容；worker 包必须提供 runtime。 */
  kind?: "declarative" | "worker";
  runtime?: CodePluginRuntime;
  /** 字符串或 { capability, hosts, methods?, paths?, maxBytes?, schedule? } 对象；安装期 Rust 侧校验形态。 */
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
    /** 命令面板条目（v2）：出现在 ⌘K / 标题栏搜索里，命中后打开本包的 mode 页。 */
    commands?: PluginCommandDecl[];
    /** 右键菜单条目（v2）：文件树 / 预览 / 对话三处。 */
    contextMenu?: PluginContextMenuDecl[];
    /** 设置项（v2）：字段值与 storage.kv 共用命名空间（key 即字段 key）。 */
    settingsSchema?: DeclarativeField[];
    /** 状态栏条目（v2）：label 是初始文案，运行时可用 setStatus 更新。 */
    statusBar?: PluginStatusBarDecl[];
    /** 键盘快捷键（v2）：宿主快捷键优先，冲突的插件键等于不存在。 */
    keybindings?: PluginKeybindingDecl[];
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
  fields?: DeclarativeField[];
  outputs?: DeclarativeOutput[];
  actions?: DeclarativeAction[];
}
