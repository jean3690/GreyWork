import type { Component } from "vue";

export interface ModeContribution {
  /** mode 标识，即路由 :mode 段，如 "chat" */
  id: string;
  /** tab 显示名 */
  title: string;
  component: Component;
}

export type UiRegionId = "shellSidebar" | "activityPanel";

export interface UiRegionContribution {
  region: UiRegionId;
  /** 面板标识，如 "activity.artifacts" */
  id: string;
  title: string;
  component: Component;
  /** 同 region 内排序，缺省排后 */
  order?: number;
  /** 低频面板：不占标签栏位，收进「更多」下拉。插件可自选，缺省为常驻标签。 */
  overflow?: boolean;
}

export interface PluginManifest {
  /** 如 "core.views" */
  id: string;
  name: string;
  /** semver */
  version: string;
  contributes?: {
    modes?: ModeContribution[];
    uiRegions?: UiRegionContribution[];
    /** 未来能力包 seam，mock 期仅登记字符串 */
    capabilities?: string[];
  };
  /** 其他 PluginManifest.id；loader 据此拓扑排序 */
  dependsOn?: string[];
}

export interface CapabilitySeam {
  /** 重复 id 抛错 */
  register(manifest: PluginManifest): void;
  /** 挂载其 modes/uiRegions 进注册快照（含依赖拓扑激活） */
  activate(id: string): Promise<void>;
  /** 从快照摘除；被依赖时拒绝并抛错 */
  deactivate(id: string): Promise<void>;
  snapshot(): Readonly<{ modes: ModeContribution[]; uiRegions: UiRegionContribution[] }>;
}
