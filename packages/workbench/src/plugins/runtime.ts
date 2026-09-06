import { createJsonStorage } from "@greywork/core";
import { ref } from "vue";
import { BUILTIN_PLUGINS } from "./builtin";
import { useCapabilityLoader } from "./current";
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

/** 已注册清单（内置 + 运行期 register）。 */
export const pluginManifests = ref<readonly PluginManifest[]>([]);
/** 当前活跃插件 id（随 enable/disable 与 boot 刷新）。 */
export const pluginActive = ref<readonly string[]>([]);

let booted = false;

function sync(): void {
  pluginActive.value = useCapabilityLoader().activeIds();
}

/** 外壳启动接线：注册内置清单并激活存档里允许的插件（幂等）。 */
export async function bootPlugins(): Promise<void> {
  if (booted) return;
  booted = true;
  const loader = useCapabilityLoader();
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
}

/** 运行期追加清单（重复 id 会被 loader 拒绝并抛错）。 */
export function registerPlugin(manifest: PluginManifest): void {
  useCapabilityLoader().register(manifest);
  pluginManifests.value = [...pluginManifests.value, manifest];
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  const loader = useCapabilityLoader();
  if (enabled) await loader.activate(id);
  else await loader.deactivate(id);
  sync();
  storage.write([...pluginActive.value]);
}

export function isPluginEnabled(id: string): boolean {
  return pluginActive.value.includes(id);
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
  pluginManifests.value = [];
  pluginActive.value = [];
}
