// Cordis 贡献聚合服务：
// 插件的 modes/uiRegions/capabilities 经 ctx.effect(() => seam.registerXxx(contribution)) 注册，
// fork scope 卸载时 effect 自动调用注册函数返回的清理函数——无需手动摘除。
// UI 侧（router/TopBar/ShellSidebar/ActivityPanel/WorkflowCanvas）在 computed 内调用 snapshot()，
// 读取 modes/uiRegions 两个 ref 建立响应式依赖。
import { Service, type Context } from "@cordisjs/core";
import { markRaw, ref, type Ref } from "vue";
import type { ModeContribution, UiRegionContribution } from "./types";

declare module "@cordisjs/core" {
  interface Context {
    seam: SeamService;
  }
}

export class SeamService extends Service {
  readonly modes: Ref<ModeContribution[]> = ref([]);
  readonly uiRegions: Ref<UiRegionContribution[]> = ref([]);
  readonly capabilities: Ref<string[]> = ref([]);

  constructor(ctx: Context) {
    super(ctx, "seam", true); // immediate:装载后立即可用
  }

  registerMode(contribution: ModeContribution): () => void {
    // 组件对象标记 raw：避免被 ref 深度代理（Vue 性能告警）。
    this.modes.value.push(contribution.component ? { ...contribution, component: markRaw(contribution.component) } : contribution);
    return () => {
      this.modes.value = this.modes.value.filter((mode) => mode.id !== contribution.id);
    };
  }

  registerUiRegion(contribution: UiRegionContribution): () => void {
    this.uiRegions.value.push(contribution.component ? { ...contribution, component: markRaw(contribution.component) } : contribution);
    return () => {
      this.uiRegions.value = this.uiRegions.value.filter((region) => region.id !== contribution.id);
    };
  }

  registerCapability(capability: string): () => void {
    this.capabilities.value.push(capability);
    return () => {
      this.capabilities.value = this.capabilities.value.filter((item) => item !== capability);
    };
  }

  snapshot(): Readonly<{ modes: ModeContribution[]; uiRegions: UiRegionContribution[] }> {
    return { modes: this.modes.value, uiRegions: this.uiRegions.value };
  }
}
