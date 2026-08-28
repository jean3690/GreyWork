// 微内核式能力加载器：register / activate / deactivate / snapshot / activateAll。
// 生命周期(装载/卸载/副作用清理)由 @cordisjs/core 的 Context/plugin/ForkScope/effect 承担，
// 本层只保留 GreyWork 业务规则：dependsOn 拓扑排序、重复 id 拒绝、被依赖时拒绝卸载，
// 并把声明式 manifest 适配为 Cordis 插件定义。
import { Context } from "@cordisjs/core";
import type { ForkScope, Plugin } from "@cordisjs/core";
import { ref } from "vue";
import { SeamService } from "./seam-service";
import type { CapabilitySeam, PluginManifest } from "./types";

export class DuplicatePluginError extends Error {
  constructor(id: string) {
    super(`plugin manifest id already registered: ${id}`);
    this.name = "DuplicatePluginError";
  }
}

export class DependentPluginError extends Error {
  constructor(id: string, dependents: string[]) {
    super(`cannot deactivate ${id}: depended on by ${dependents.join(", ")}`);
    this.name = "DependentPluginError";
  }
}

export class UnknownPluginError extends Error {
  constructor(id: string) {
    super(`unknown plugin id: ${id}`);
    this.name = "UnknownPluginError";
  }
}

/** 能力加载器契约：seam 基础上追加批量激活与激活集观测。 */
export interface CapabilityLoader extends CapabilitySeam {
  /** 按依赖拓扑序一次性激活全部已注册清单（bootstrap 调用）。 */
  activateAll(): Promise<void>;
  activeIds(): readonly string[];
}

/**
 * manifest → Cordis 插件定义：apply 时把 modes/uiRegions/capabilities 贡献注册进 seam。
 * 注册经 ctx.effect 包装——fork scope 卸载时自动调用清理函数，贡献随之消失。
 */
function manifestToPlugin(manifest: PluginManifest): Plugin.Object<Context> {
  return {
    name: manifest.id,
    // 显式声明服务依赖：消除「property seam is not registered」告警；
    // seam 为 immediate 服务且常驻 root，插件装载时必可用。
    inject: ["seam"],
    apply: (ctx) => {
      for (const mode of manifest.contributes?.modes ?? []) {
        ctx.effect(() => ctx.seam.registerMode(mode));
      }
      for (const region of manifest.contributes?.uiRegions ?? []) {
        ctx.effect(() => ctx.seam.registerUiRegion(region));
      }
      for (const capability of manifest.contributes?.capabilities ?? []) {
        ctx.effect(() => ctx.seam.registerCapability(capability));
      }
    },
  };
}

export function createCapabilityLoader(): CapabilityLoader {
  const ctx = new Context();
  // 装载 seam 服务（immediate）：贡献聚合 ref 立即可用。
  ctx.plugin(SeamService);

  /** 已注册清单：拓扑排序与被依赖检查依据（业务规则，不随 Cordis 生命周期销毁）。 */
  const manifestById = new Map<string, PluginManifest>();
  /** manifest 对应的 Cordis 插件定义（唯一，供 ctx.plugin 装载）。 */
  const pluginById = new Map<string, Plugin.Object<Context>>();
  /** 已装载插件：id → fork scope；卸载时 fork.dispose() 触发 effect 清理。 */
  const forkById = new Map<string, ForkScope>();
  const active = ref(new Set<string>());

  function assertAcyclic(id: string, seen = new Set<string>()): void {
    if (seen.has(id)) throw new Error(`circular dependsOn involving ${id}`);
    seen.add(id);
    const manifest = manifestById.get(id);
    for (const dep of manifest?.dependsOn ?? []) {
      if (!manifestById.has(dep)) throw new Error(`missing dependency ${dep} required by ${id}`);
      assertAcyclic(dep, seen);
    }
  }

  /** 按 dependsOn 拓扑排序（Kahn），返回激活顺序。 */
  function topoOrder(ids: Iterable<string>): string[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of ids) indegree.set(id, 0);
    for (const id of ids) {
      for (const dep of manifestById.get(id)?.dependsOn ?? []) {
        if (!indegree.has(dep)) continue;
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
        dependents.set(dep, [...(dependents.get(dep) ?? []), id]);
      }
    }
    const queue = [...ids].filter((id) => (indegree.get(id) ?? 0) === 0);
    const order: string[] = [];
    while (queue.length) {
      const id = queue.shift() as string;
      order.push(id);
      for (const next of dependents.get(id) ?? []) {
        const left = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, left);
        if (left === 0) queue.push(next);
      }
    }
    if (order.length !== indegree.size) throw new Error("circular dependsOn detected");
    return order;
  }

  return {
    register(manifest: PluginManifest): void {
      if (manifestById.has(manifest.id)) throw new DuplicatePluginError(manifest.id);
      manifestById.set(manifest.id, manifest);
      pluginById.set(manifest.id, manifestToPlugin(manifest));
      try {
        assertAcyclic(manifest.id);
      } catch (error) {
        manifestById.delete(manifest.id);
        pluginById.delete(manifest.id);
        throw error;
      }
    },

    async activate(id: string): Promise<void> {
      if (!manifestById.has(id)) throw new UnknownPluginError(id);
      for (const dep of topoOrder([id])) {
        if (!forkById.has(dep)) forkById.set(dep, ctx.plugin(pluginById.get(dep)!));
      }
      active.value = new Set(forkById.keys());
    },

    async deactivate(id: string): Promise<void> {
      if (!manifestById.has(id)) throw new UnknownPluginError(id);
      const dependents = [...forkById.keys()].filter((other) => (manifestById.get(other)?.dependsOn ?? []).includes(id));
      if (dependents.length) throw new DependentPluginError(id, dependents);
      // fork.dispose() 同步执行 scope 内全部 effect 清理函数，贡献从 seam 摘除。
      forkById.get(id)?.dispose();
      forkById.delete(id);
      active.value = new Set(forkById.keys());
    },

    snapshot() {
      return ctx.seam.snapshot();
    },

    async activateAll(): Promise<void> {
      for (const id of topoOrder([...manifestById.keys()])) {
        if (!forkById.has(id)) forkById.set(id, ctx.plugin(pluginById.get(id)!));
      }
      active.value = new Set(forkById.keys());
    },

    activeIds: () => [...active.value],
  };
}

/** 应用级单例 seam：AppShell bootstrap 时 register 默认清单 + activateAll()。 */
export const capabilitySeam: CapabilityLoader = createCapabilityLoader();
