// 微内核式能力加载器：register / activate / deactivate / snapshot / activateAll。
// 生命周期(装载/卸载/副作用清理)由 @cordisjs/core 的 Context/plugin/ForkScope/effect 承担，
// 本层只保留 GreyWork 业务规则：dependsOn 拓扑排序、重复 id 拒绝、被依赖时拒绝卸载，
// 并把声明式 manifest 适配为 Cordis 插件定义。
import { Context } from "@cordisjs/core";
import type { ForkScope, Plugin } from "@cordisjs/core";
import { ref } from "vue";
import { SeamService } from "./seam-service";
import type { CapabilitySeam, PluginManifest } from "./types";
import { CAPABILITY_REGISTRY, capabilityTitle, normalizeGrantSpec, recordCapabilityAudit } from "./capabilities";

export class CapabilityCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityCallError";
  }
}

export class DuplicatePluginError extends Error {
  constructor(id: string) {
    super(`plugin manifest id already registered: ${id}`);
    this.name = "DuplicatePluginError";
  }
}
export class ContributionConflictError extends Error {
  constructor(kind: "mode" | "uiRegion", id: string, ownerId: string) {
    super(`${kind} contribution id already registered: ${id} (owned by ${ownerId})`);
    this.name = "ContributionConflictError";
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

export class CapabilityRequiredError extends Error {
  constructor(id: string, missing: string[]) {
    super(
      `cannot activate ${id}: missing grants for ${missing.map((capability) => `${capability} (${capabilityTitle(capability)})`).join(", ")}`,
    );
    this.name = "CapabilityRequiredError";
  }
}
export class ActivePluginError extends Error {
  constructor(id: string) {
    super(`cannot unregister active plugin: ${id}`);
    this.name = "ActivePluginError";
  }
}

/** 能力加载器契约：seam 基础上追加批量激活、激活集观测、授权门禁与运行期能力调用。 */
export interface CapabilityLoader extends CapabilitySeam {
  /** 按依赖拓扑序一次性激活全部已注册清单（bootstrap 调用）。 */
  activateAll(): Promise<void>;
  activeIds(): readonly string[];
  /** 授权一个能力 id（幂等；只作用于之后的激活判定，不动已激活插件）。 */
  grantCapability(capability: string): void;
  /** 撤销授权（不影响已激活插件；但运行期能力调用即时被拒）。 */
  revokeCapability(capability: string): void;
  isCapabilityGranted(capability: string): boolean;
  /** 当前已授权能力 id 列表快照。 */
  grantedCapabilities(): readonly string[];
  /** 设置可信插件 id 集（宿主签名内置插件）：其 requires 自动满足。默认空集。 */
  setTrustedPluginIds(ids: readonly string[]): void;
  /**
   * 运行期能力调用（worker host-call 通道的宿主侧收口）：
   * 每次调用实时校验「插件已声明 + 全局已授权 + 注册表已登记」，任一不满足即抛错。
   * revokeCapability 之后立即生效 —— 已激活插件的下一次调用即被拒绝。
   */
  callCapability(pluginId: string, capability: string, args: unknown): Promise<unknown>;
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
  /** 全局已授权能力集（白名单）；由 runtime 从 capabilityGrants 存档重放。 */
  const grantedCapabilities = new Set<string>();
  /** 可信插件 id（内置，宿主签名）；其 requires 视为已满足。默认空集。 */
  let trustedPluginIds: ReadonlySet<string> = new Set();

  function assertAcyclic(id: string, visiting = new Set<string>(), visited = new Set<string>()): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`circular dependsOn involving ${id}`);
    visiting.add(id);
    const manifest = manifestById.get(id);
    for (const dep of manifest?.dependsOn ?? []) {
      if (!manifestById.has(dep)) throw new Error(`missing dependency ${dep} required by ${id}`);
      assertAcyclic(dep, visiting, visited);
    }
    visiting.delete(id);
    visited.add(id);
  }

  /** 单插件激活也必须包含其完整依赖闭包，而非只对目标 id 排序。 */
  function dependencyClosure(id: string, ids = new Set<string>()): Set<string> {
    if (ids.has(id)) return ids;
    ids.add(id);
    for (const dep of manifestById.get(id)?.dependsOn ?? []) dependencyClosure(dep, ids);
    return ids;
  }

  /** mode 与 uiRegion id 都是宿主持久化/清理键，注册期全局唯一。 */
  function assertContributionIds(candidate: PluginManifest): void {
    const claimedModes = new Map<string, string>();
    const claimedRegions = new Map<string, string>();
    for (const manifest of manifestById.values()) {
      for (const mode of manifest.contributes?.modes ?? []) claimedModes.set(mode.id, manifest.id);
      for (const region of manifest.contributes?.uiRegions ?? []) claimedRegions.set(region.id, manifest.id);
    }

    const ownModes = new Set<string>();
    for (const mode of candidate.contributes?.modes ?? []) {
      const owner = claimedModes.get(mode.id) ?? (ownModes.has(mode.id) ? candidate.id : undefined);
      if (owner) throw new ContributionConflictError("mode", mode.id, owner);
      ownModes.add(mode.id);
    }

    const ownRegions = new Set<string>();
    for (const region of candidate.contributes?.uiRegions ?? []) {
      const owner = claimedRegions.get(region.id) ?? (ownRegions.has(region.id) ? candidate.id : undefined);
      if (owner) throw new ContributionConflictError("uiRegion", region.id, owner);
      ownRegions.add(region.id);
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

  /** 门禁：返回该插件尚未授权、须补齐的 requires 子集（可信插件恒为空）。 */
  function missingGrants(id: string): string[] {
    if (trustedPluginIds.has(id)) return [];
    return (manifestById.get(id)?.requires ?? [])
      .map((spec) => normalizeGrantSpec(spec).capability)
      .filter((capability) => !grantedCapabilities.has(capability));
  }

  /** 插件对某能力的声明式授权（含参数）。找不到返回 null —— 未声明即不可调用。 */
  function declaredGrant(id: string, capability: string): { capability: string; hosts?: string[] } | null {
    for (const spec of manifestById.get(id)?.requires ?? []) {
      const grant = normalizeGrantSpec(spec);
      if (grant.capability === capability) return grant;
    }
    return null;
  }

  return {
    register(manifest: PluginManifest): void {
      if (manifestById.has(manifest.id)) throw new DuplicatePluginError(manifest.id);
      assertContributionIds(manifest);
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

    unregister(id: string): void {
      if (!manifestById.has(id)) throw new UnknownPluginError(id);
      if (forkById.has(id)) throw new ActivePluginError(id);
      const dependents = [...manifestById.values()]
        .filter((manifest) => (manifest.dependsOn ?? []).includes(id))
        .map((manifest) => manifest.id);
      if (dependents.length) throw new DependentPluginError(id, dependents);
      manifestById.delete(id);
      pluginById.delete(id);
    },

    async activate(id: string): Promise<void> {
      if (!manifestById.has(id)) throw new UnknownPluginError(id);
      const order = topoOrder(dependencyClosure(id));
      // 门禁预检：装载任何 fork 前校验全部将激活插件的 requires —— 失败即整体拒绝，
      // 不留半个活跃集。只检未激活者：已激活插件重复 activate 保持幂等放行。
      for (const dep of order) {
        if (!forkById.has(dep)) {
          const missing = missingGrants(dep);
          if (missing.length) throw new CapabilityRequiredError(dep, missing);
        }
      }
      for (const dep of order) {
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
      const order = topoOrder([...manifestById.keys()]);
      // 与 activate 同款门禁预检：全部就绪才逐个装载，任一缺授权即整体拒绝。
      for (const id of order) {
        if (!forkById.has(id)) {
          const missing = missingGrants(id);
          if (missing.length) throw new CapabilityRequiredError(id, missing);
        }
      }
      for (const id of order) {
        if (!forkById.has(id)) forkById.set(id, ctx.plugin(pluginById.get(id)!));
      }
      active.value = new Set(forkById.keys());
    },

    activeIds: () => [...active.value],

    async callCapability(pluginId: string, capability: string, args: unknown): Promise<unknown> {
      const deny = (detail: string): CapabilityCallError => {
        recordCapabilityAudit({ plugin: pluginId, capability, at: new Date().toISOString(), outcome: "denied", detail });
        return new CapabilityCallError(`capability ${capability} denied for ${pluginId}: ${detail}`);
      };
      const definition = CAPABILITY_REGISTRY[capability];
      if (!definition) throw deny("capability is not registered in the host");
      if (!forkById.has(pluginId)) throw deny("plugin is not active");
      if (!trustedPluginIds.has(pluginId)) {
        const grant = declaredGrant(pluginId, capability);
        if (!grant) throw deny("capability is not declared in the plugin manifest");
        // 调用时实时校验全局授权集 —— revokeCapability 后下一次调用即被拒绝。
        if (!grantedCapabilities.has(capability)) throw deny("capability grant has been revoked or was never given");
        return definition.invoke(args, {
          pluginId,
          grant,
          audit: recordCapabilityAudit,
        });
      }
      // 可信（内置）插件：声明即授权，同样经 broker 收口。
      const grant = declaredGrant(pluginId, capability) ?? { capability };
      return definition.invoke(args, { pluginId, grant, audit: recordCapabilityAudit });
    },

    grantCapability(capability: string): void {
      grantedCapabilities.add(capability);
    },
    revokeCapability(capability: string): void {
      grantedCapabilities.delete(capability);
    },
    isCapabilityGranted: (capability: string) => grantedCapabilities.has(capability),
    grantedCapabilities: () => [...grantedCapabilities],
    setTrustedPluginIds(ids: readonly string[]): void {
      trustedPluginIds = new Set(ids);
    },
  };
}

/** 应用级单例 seam：外壳 bootstrap 时 register 默认清单 + activateAll()。 */
export const capabilitySeam: CapabilityLoader = createCapabilityLoader();
