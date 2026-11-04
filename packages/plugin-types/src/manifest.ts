/**
 * 插件包清单：作者写给宿主看的唯一契约。
 *
 * 字段与校验以 `crates/greywork-host/src/services/plugin_market/package.rs::validate_package`
 * 为准（安装期在 Rust 侧逐项校验，前端只做展示）。这里的注释标注了关键边界，
 * 越界不会「静默降级」，而是整包被拒。
 */

/** 声明式状态只支持三种标量：宿主对象把字段值写进持久化状态，结构越简单越安全。 */
export type DeclarativeValue = string | number | boolean;

/** UI 区域宿主（与 workbench 的 UiRegionId 同口径）。 */
export type UiRegionId = "shellSidebar" | "activityPanel" | "workspaceOverlay";

export type FieldKind = "text" | "number" | "toggle";

export type ActionStyle = "primary" | "secondary" | "danger";

/** 声明式动作：不写代码也能改状态。`invoke` 只对 worker 包合法。 */
export type DeclarativeOperation =
  | { type: "increment"; key: string; amount?: number }
  | { type: "set"; key: string; value: DeclarativeValue }
  | { type: "reset" }
  | { type: "invoke"; handler: string };

export interface DeclarativeField {
  key: string;
  label: string;
  description?: string;
  kind: FieldKind;
  default: DeclarativeValue;
  /** kind=text：最大字符数。 */
  maxLength?: number;
  /** kind=number：区间与步长。 */
  min?: number;
  max?: number;
  step?: number;
}

export interface DeclarativeOutput {
  label: string;
  valueKey: string;
  suffix?: string;
}

export interface DeclarativeAction {
  id: string;
  label: string;
  /** 缺省按 secondary 渲染 */
  style?: ActionStyle;
  operation: DeclarativeOperation;
}

/** 全页 mode：`id` 即 /plugin/:modeId 的路径段。 */
export interface ModeDeclaration {
  id: string;
  /** ≤120 字符 */
  title: string;
  /** lib/icons 的键名，缺省 "magic"。 */
  icon?: string;
  page: {
    /** ≤120 字符；缺省不渲染 */
    eyebrow?: string;
    /** ≤160 字符 */
    heading: string;
    /** ≤16 KiB */
    body: string;
    fields?: DeclarativeField[];
    outputs?: DeclarativeOutput[];
    actions?: DeclarativeAction[];
  };
}

/** 常驻区域：必须同时声明 runtime.render（宿主用渲染指令画内容）。 */
export interface UiRegionDeclaration {
  region: UiRegionId;
  /** region 内唯一；兼作持久化激活键。 */
  id: string;
  /** ≤80 字符 */
  title: string;
  order?: number;
  /** 仅 activityPanel：低频面板收进「更多」。 */
  overflow?: boolean;
}

/** 命令面板条目（v2）：只做导航，`mode` 缺省取第一个 mode。 */
export interface CommandDeclaration {
  id: string;
  /** ≤60 字符 */
  title: string;
  /** ≤120 字符 */
  description?: string;
  mode?: string;
}

/** 右键菜单条目（v2）：同样只做导航。 */
export interface ContextMenuDeclaration {
  id: string;
  /** ≤40 字符 */
  label: string;
  targets: PluginContextTarget[];
  mode?: string;
}

export type PluginContextTarget = "fileTree" | "preview" | "conversation";

/** 状态栏条目（v2）：`greywork.setStatus(id, text)` 的寻址键。 */
export interface StatusBarDeclaration {
  id: string;
  /** ≤60 字符 */
  label: string;
  mode?: string;
}

/** 键盘快捷键（v2）：命中后打开插件页；与宿主快捷键冲突时插件键不存在。 */
export interface KeybindingDeclaration {
  id: string;
  /** 修饰键 + 键名，如 "mod+shift+k" / "F8"。 */
  key: string;
  mode?: string;
}

/** 设置项（v2）：值写进该插件自己的 storage.kv 命名空间，key 即字段 key。 */
export interface SettingsFieldDeclaration {
  key: string;
  label: string;
  kind: FieldKind;
  default: DeclarativeValue;
}

/** worker 运行时声明；声明式包禁止出现 runtime。 */
export interface WorkerRuntimeDeclaration {
  type: "worker";
  /** 必须是允许的 GitHub HTTPS 地址（钉 commit）。 */
  entry: string;
  /** 64 位小写 hex，安装期校验下载内容。 */
  sha256: string;
  /** 可选渲染循环：worker 暴露 handler，宿主按 fps 拉取渲染指令。 */
  render?: {
    handler: string;
    /** 1-60，缺省 12 */
    fps?: number;
    /** 1-512 px */
    width?: number;
    /** 1-512 px */
    height?: number;
    /** 声明 true 才派发指针事件（见 GreyworkGlobal.registerPointer）。 */
    pointer?: boolean;
  };
}

/** 悬浮窗（v2）：需同时声明 requires: ["window.floating"] 与 worker + render。 */
export interface WindowDeclaration {
  /** 1-512 px */
  width: number;
  height: number;
  /** ≤64 字符，无控制字符 */
  title?: string;
  alwaysOnTop?: boolean;
  /** 0.2-1 */
  opacity?: number;
  multiple?: boolean;
}

/** 能力声明：字符串 = 无参数；对象 = 带资源参数的最小特权（见 capabilities.ts）。 */
export type CapabilityGrant = string | ManifestCapabilityGrant;

export interface ManifestCapabilityGrant {
  capability: string;
  /** net.fetch：host 白名单（不含协议与路径）。 */
  hosts?: string[];
  /** net.fetch：GET / HEAD / POST。 */
  methods?: string[];
  /** net.fetch：仅 POST 需要，`*` 段内 / `**` 跨段。 */
  paths?: string[];
  /** net.fetch：单次上下行字节上限（1 KiB - 8 MiB）。 */
  maxBytes?: number;
  /** schedule：目前只有固定间隔。 */
  schedule?: { kind: "interval"; min: number };
  /** llm.chat：1-8 条模型白名单。 */
  models?: string[];
  /** clipboard：read / write 子集；只写可省。 */
  ops?: string[];
  /** mcp.connect：按名字引用用户已配置的服务器 + 工具白名单。 */
  servers?: { name: string; tools: string[] }[];
}

export interface PluginContributions {
  modes?: ModeDeclaration[];
  uiRegions?: UiRegionDeclaration[];
  commands?: CommandDeclaration[];
  contextMenu?: ContextMenuDeclaration[];
  statusBar?: StatusBarDeclaration[];
  keybindings?: KeybindingDeclaration[];
  settingsSchema?: SettingsFieldDeclaration[];
}

export interface PluginManifest {
  /** 小写 [a-z0-9._-]，≤96 字符；`core.` 保留给内置插件。 */
  id: string;
  /** 1-120 字符 */
  name: string;
  /** x.y.z */
  version: string;
  description?: string;
  /** 缺省 declarative。 */
  kind?: "declarative" | "worker";
  runtime?: WorkerRuntimeDeclaration;
  window?: WindowDeclaration;
  requires?: CapabilityGrant[];
  contributes?: PluginContributions;
}

/** 市场分发的包文件；`code` 由宿主在安装时注入，不要随包发布。 */
export interface PluginPackage {
  schemaVersion: 1;
  manifest: PluginManifest;
}
