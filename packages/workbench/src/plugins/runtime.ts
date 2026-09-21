import { createJsonStorage } from "@greywork/core";
import { ref } from "vue";
import { BUILTIN_PLUGINS } from "./builtin";
import { useCapabilityLoader } from "./current";
import { closePluginWindow } from "./plugin-window";
import type { PluginManifest } from "./types";

/**
 * 插件启停的运行时状态：注册清单 → 按持久化启停集合激活 → 把 loader 的活跃集映成
 * 响应式 UI 状态。loader（cordis 层）只关心生命周期与依赖拓扑，不关心「谁被允许开」。
 *
 * 持久化语义：首次启动无存档 = 全部内置默认激活；此后 localStorage 记录的是
 * 启停后的完整活跃 id 集（空数组 = 全关，是事实而非缺省）。
 *
 * 测试：setCapabilityLoaderForTest 换掉 current loader 后，调 resetPluginRuntime()
 * 再 boot，即可对整套管线（register → activate → seam → 组件）做隔离断言。
 */
const STORAGE_KEY = "greywork.plugins.enabled";

const storage = createJsonStorage<string[]>(
  STORAGE_KEY,
  (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"),
);

/**
 * 授权存档（v2）：pluginId → 已授权能力 id 列表。按插件隔离 —— 授权给谁就只放行谁。
 * 与 enabled 存档同构：无默认值、boot 不写回、坏值回退空 —— 空对象 = 无任何授权。
 */
const GRANTS_STORAGE_KEY = "greywork.plugins.capabilityGrants.v2";

type GrantsArchive = Record<string, string[]>;

function isGrantsArchive(value: unknown): value is GrantsArchive {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => Array.isArray(entry) && entry.every((capability) => typeof capability === "string"));
}

const grantsStorage = createJsonStorage<GrantsArchive>(GRANTS_STORAGE_KEY, isGrantsArchive);

/**
 * v1 授权存档（全局能力白名单）—— 只读，用于一次性迁移到按插件粒度：
 * 历史全局授权在注册时落到「声明了该能力」的插件上，迁移后写回 v2 并删除 v1 键。
 */
const LEGACY_GRANTS_STORAGE_KEY = "greywork.plugins.capabilityGrants";

const legacyGrantsStorage = createJsonStorage<string[]>(
  LEGACY_GRANTS_STORAGE_KEY,
  (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string"),
);

/** 已注册清单（内置 + 运行期 register）。 */
export const pluginManifests = ref<readonly PluginManifest[]>([]);
/** 当前活跃插件 id（随 enable/disable 与 boot 刷新）。 */
export const pluginActive = ref<readonly string[]>([]);
/** 已授权能力（按插件隔离的事实集；随 grant/revoke 与 boot 刷新）。 */
export const capabilityGrants = ref<Readonly<Record<string, readonly string[]>>>({});

let booted = false;
/**
 * 本会话是否加载了 v1 全局授权：为真时后续每次 register 都可能派生新的按插件授权，
 * 需要重新持久化 v2（市场包在 boot 之后才注册）。
 */
let legacyMigrationActive = false;
/** v1 键是否待清理（迁移结果首次写回后删掉，避免下次重复迁移）。 */
let legacyKeyCleanupPending = false;

function sync(): void {
  const loader = useCapabilityLoader();
  pluginActive.value = loader.activeIds();
  capabilityGrants.value = loader.grantedCapabilities();
}

function persistGrants(): void {
  grantsStorage.write(Object.fromEntries(Object.entries(capabilityGrants.value).map(([id, caps]) => [id, [...caps]])));
  if (legacyKeyCleanupPending) {
    legacyKeyCleanupPending = false;
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(LEGACY_GRANTS_STORAGE_KEY);
    } catch {
      // 存储不可用：v1 键留着，下次 boot 会幂等重放（已授权项重复授予无副作用）。
    }
  }
}

/** 外壳启动接线：注册内置清单并激活存档里允许的插件（幂等）。 */
export async function bootPlugins(): Promise<void> {
  if (booted) return;
  booted = true;
  const loader = useCapabilityLoader();
  const storedGrants = grantsStorage.read();
  if (storedGrants) {
    for (const [pluginId, capabilities] of Object.entries(storedGrants)) {
      for (const capability of capabilities) loader.grantCapability(pluginId, capability);
    }
  } else {
    // 无 v2 存档：尝试 v1 全局白名单迁移（在 register 前登记，注册时落到各插件上）。
    const legacy = legacyGrantsStorage.read();
    if (legacy?.length) {
      loader.grantLegacyCapabilities(legacy);
      legacyMigrationActive = true;
      legacyKeyCleanupPending = true;
    }
  }
  loader.setTrustedPluginIds(BUILTIN_PLUGINS.map((manifest) => manifest.id));
  for (const manifest of BUILTIN_PLUGINS) {
    try {
      loader.register(manifest);
      pluginManifests.value = [...pluginManifests.value, manifest];
    } catch {
      // 重复注册：同一 loader 上二次 boot 不应发生，容错即可
    }
  }
  const defaults = BUILTIN_PLUGINS.map((manifest) => manifest.id);
  const stored = storage.read();
  const wanted = stored === null ? defaults : stored.filter((id) => pluginManifests.value.some((m) => m.id === id));
  for (const id of wanted) {
    try {
      await loader.activate(id);
    } catch (error) {
      console.error(`[plugins] 激活 ${id} 失败`, error);
    }
  }
  if (stored === null) storage.write(defaults);
  sync();
  // 迁移结果（若有）在注册完内置后落盘：v2 写回 + 清 v1 键。
  if (legacyMigrationActive) persistGrants();
}

/** 运行期追加清单（重复 id 会被 loader 拒绝并抛错）。 */
export function registerPlugin(manifest: PluginManifest): void {
  useCapabilityLoader().register(manifest);
  pluginManifests.value = [...pluginManifests.value, manifest];
  // 迁移期后注册的插件（如市场包）也要把历史全局授权落到自己身上并持久化。
  if (legacyMigrationActive) {
    sync();
    persistGrants();
  }
}

/** 注销未激活插件；市场卸载使用，清单与 loader 保持原子一致。 */
export function unregisterPlugin(id: string): void {
  useCapabilityLoader().unregister(id);
  pluginManifests.value = pluginManifests.value.filter((manifest) => manifest.id !== id);
}

/**
 * 清空某插件的全部授权（卸载用）：否则卸载后重装同 id 的**另一个**包会继承旧授权。
 * 升级不调用此函数 —— 升级保授权。
 */
export function clearPluginCapabilityGrants(pluginId: string): void {
  const loader = useCapabilityLoader();
  for (const capability of capabilityGrants.value[pluginId] ?? []) {
    loader.revokeCapability(pluginId, capability);
  }
  sync();
  persistGrants();
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const loader = useCapabilityLoader();
  if (enabled) {
    await loader.activate(id);
  } else {
    await loader.deactivate(id);
    // 停用即回收悬浮窗：窗口里跑的是该插件的 render worker，留着会渲染已停用的包。
    await closePluginWindow(id);
  }
  sync();
  storage.write([...pluginActive.value]);
}

export function isPluginEnabled(id: string): boolean {
  return pluginActive.value.includes(id);
}

/** 持久化授予某插件一项能力；只影响该插件之后的激活判定，不暗中启停插件。 */
export function grantPluginCapability(pluginId: string, capability: string): void {
  const loader = useCapabilityLoader();
  loader.grantCapability(pluginId, capability);
  sync();
  persistGrants();
}

/** 持久化撤销某插件的能力；已激活插件保持运行，重新激活时再次受门禁约束。 */
export function revokePluginCapability(pluginId: string, capability: string): void {
  const loader = useCapabilityLoader();
  loader.revokeCapability(pluginId, capability);
  sync();
  persistGrants();
}

export function isPluginCapabilityGranted(pluginId: string, capability: string): boolean {
  return (capabilityGrants.value[pluginId] ?? []).includes(capability);
}

/**
 * 恢复全部内置插件（含停用后把插件中心页一起锁死的场景）。
 *
 * 语义：内置清单全量重新激活，第三方插件的活跃状态并入不丢；
 * 持久化写回新活跃集（storage 语义 = 完整活跃 id 集）。幂等：
 * 已激活的内置插件会被 loader 忽略/报重复 —— 逐个 try 容错。
 */
export async function restoreBuiltinPlugins(): Promise<void> {
  const loader = useCapabilityLoader();
  const builtinIds = BUILTIN_PLUGINS.map((manifest) => manifest.id);
  const keepThirdParty = pluginActive.value.filter((id) => !builtinIds.includes(id));
  for (const id of [...builtinIds, ...keepThirdParty]) {
    try {
      await loader.activate(id);
    } catch {
      // 已激活或依赖缺失：交给 sync() 后的真实状态反映，不阻断恢复。
    }
  }
  sync();
  storage.write([...pluginActive.value]);
}

/** 测试钩子：清掉 booted 与清单状态（不动 loader 本身），换 loader 后配合 boot 重放。 */
export function resetPluginRuntime(): void {
  booted = false;
  legacyMigrationActive = false;
  legacyKeyCleanupPending = false;
  pluginManifests.value = [];
  pluginActive.value = [];
  capabilityGrants.value = {};
}
