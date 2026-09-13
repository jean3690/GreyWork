import type { CapabilityGrantSpec } from "./capabilities";
import type { Component } from "vue";

export interface ModeContribution {
  /** mode 标识，即 /plugin/:modeId 的 :modeId 段 */
  id: string;
  /** 侧栏入口显示名 */
  title: string;
  /** 侧栏入口图标键（lib/icons 的 ICONS 键名），缺省 "magic" */
  icon?: string;
  component: Component;
}

/**
 * UI 区域宿主：
 * - `activityPanel`：底部整宽活动面板通栏 `ActivityBand`（VSCode 式，横跨内容区+预览列下方）。
 *   每个常驻贡献 = 一个页签，激活者渲染内容；宿主从 seam 快照响应式增删。
 * - `shellSidebar`：左栏分组宿主 `SiderRegions`（Sider 快捷入口与会话历史之间）。
 *   每个贡献 = 一个标题分组（小标 + 内容块），无激活概念、全部渲染。
 * - `workspaceOverlay`：工作台内 `position: fixed` 浮层，不参与页面布局，可拖拽定位。
 */
export type UiRegionId = "shellSidebar" | "activityPanel" | "workspaceOverlay";

export interface UiRegionContribution {
  region: UiRegionId;
  /** region 内唯一标识；兼作持久化激活键（如 "activity.artifacts"）。 */
  id: string;
  /** 原样呈现为页签/分组标题，不做 i18n（插件自带文案）。 */
  title: string;
  component: Component;
  /**
   * 同 region 内排序：升序；缺省视为排在有 order 的贡献之后；
   * 相等/缺省按注册序稳定排。
   */
  order?: number;
  /**
   * 仅对 activityPanel 生效：低频面板不占常驻标签条位，收进「更多」下拉；
   * 选中后照常渲染内容。shellSidebar 忽略（竖向分组无标签条压力，
   * 隐藏一组只会把它锁死在 248px 栏里）。
   */
  overflow?: boolean;
}

export interface PluginManifest {
  /** 如 "core.views" */
  id: string;
  name: string;
  /** semver */
  version: string;
  /** 一句话说明（插件中心展示用） */
  description?: string;
  contributes?: {
    modes?: ModeContribution[];
    uiRegions?: UiRegionContribution[];
    /**
     * 提供目录：宿主据此展示/查询该插件能提供的能力；未来宿主 API 的 key 依据。
     * 不构成启用条件（启用门禁看根级 `requires`）。
     */
    capabilities?: string[];
  };
  /** 其他 PluginManifest.id；loader 据此拓扑排序 */
  dependsOn?: string[];
  /**
   * 激活所需能力（授权门禁）：requires 的能力必须在全局授权集内，否则 activate 抛
   * CapabilityRequiredError。宿主签名（内置）插件自动满足，无需授权。
   * 字符串 = 无参数；对象 = 带资源参数的最小特权声明（如 net.fetch 的 hosts 白名单），
   * 未在此声明的能力即使全局已授权，运行期调用也会被拒绝。
   */
  requires?: CapabilityGrantSpec[];
}

export interface CapabilitySeam {
  /** 重复 id 抛错 */
  register(manifest: PluginManifest): void;
  /** 注销未激活清单；用于市场卸载后允许同 id 重新安装。 */
  unregister(id: string): void;
  /** 挂载其 modes/uiRegions 进注册快照（含依赖拓扑激活） */
  activate(id: string): Promise<void>;
  /** 从快照摘除；被依赖时拒绝并抛错 */
  deactivate(id: string): Promise<void>;
  snapshot(): Readonly<{ modes: ModeContribution[]; uiRegions: UiRegionContribution[] }>;
}
