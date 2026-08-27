// 微内核式能力加载器：register / activate / deactivate / snapshot / activateAll。
// mock 阶段仅本地清单；dependsOn 拓扑排序；重复 id 抛错；被依赖时拒绝卸载。
import { computed, ref } from "vue";
import type { CapabilitySeam, ModeContribution, PluginManifest, UiRegionContribution } from "./types";

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

export function createCapabilityLoader(): CapabilityLoader {
  const manifests = new Map<string, PluginManifest>();
  const active = ref(new Set<string>());

  const modes = computed<ModeContribution[]>(() => {
    const out: ModeContribution[] = [];
    for (const manifest of manifests.values()) {
      if (!active.value.has(manifest.id)) continue;
      out.push(...(manifest.contributes?.modes ?? []));
    }
    return out;
  });

  const uiRegions = computed<UiRegionContribution[]>(() => {
    const out: UiRegionContribution[] = [];
    for (const manifest of manifests.values()) {
      if (!active.value.has(manifest.id)) continue;
      out.push(...(manifest.contributes?.uiRegions ?? []));
    }
    out.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
    return out;
  });

  function assertAcyclic(id: string, seen = new Set<string>()): void {
    if (seen.has(id)) throw new Error(`circular dependsOn involving ${id}`);
    seen.add(id);
    const manifest = manifests.get(id);
    for (const dep of manifest?.dependsOn ?? []) {
      if (!manifests.has(dep)) throw new Error(`missing dependency ${dep} required by ${id}`);
      assertAcyclic(dep, seen);
    }
  }

  /** 按 dependsOn 拓扑排序（Kahn），返回激活顺序。 */
  function topoOrder(ids: Iterable<string>): string[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const id of ids) indegree.set(id, 0);
    for (const id of ids) {
      for (const dep of manifests.get(id)?.dependsOn ?? []) {
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
      if (manifests.has(manifest.id)) throw new DuplicatePluginError(manifest.id);
      manifests.set(manifest.id, manifest);
      try {
        assertAcyclic(manifest.id);
      } catch (error) {
        manifests.delete(manifest.id);
        throw error;
      }
    },

    async activate(id: string): Promise<void> {
      if (!manifests.has(id)) throw new UnknownPluginError(id);
      const next = new Set(active.value);
      for (const dep of topoOrder([id])) next.add(dep);
      active.value = next;
    },

    async deactivate(id: string): Promise<void> {
      if (!manifests.has(id)) throw new UnknownPluginError(id);
      const dependents = [...active.value].filter((other) => (manifests.get(other)?.dependsOn ?? []).includes(id));
      if (dependents.length) throw new DependentPluginError(id, dependents);
      const next = new Set(active.value);
      next.delete(id);
      active.value = next;
    },

    snapshot() {
      return {
        modes: modes.value,
        uiRegions: uiRegions.value,
      } as Readonly<{ modes: ModeContribution[]; uiRegions: UiRegionContribution[] }>;
    },

    async activateAll(): Promise<void> {
      const next = new Set<string>();
      for (const id of topoOrder([...manifests.keys()])) next.add(id);
      active.value = next;
    },

    activeIds: () => [...active.value],
  };
}

/** 应用级单例 seam：AppShell bootstrap 时 register 默认清单 + activateAll()。 */
export const capabilitySeam: CapabilityLoader = createCapabilityLoader();
