import { createPluginRegistry, type PluginRegistry } from "./registry";
import type { PluginManifest } from "./types";

export interface PluginStoreOptions {
  /** 内置市场清单，后续可替换为远程拉取 */
  remoteMarketplace?: PluginManifest[];
  /** 首次安装时预置的插件 */
  initialInstalled?: string[];
  /** localStorage key，传 false 关闭持久化 */
  storageKey?: string;
  /** 是否持久化已安装列表 */
  persist?: boolean;
}

export interface PluginStore {
  registry: PluginRegistry;
  marketplace: PluginManifest[];
  installedIds(): string[];
  install(id: string): boolean;
  uninstall(id: string): boolean;
  isInstalled(id: string): boolean;
  listInstalled(): PluginManifest[];
}

export function createPluginStore(options: PluginStoreOptions = {}): PluginStore {
  const { remoteMarketplace = [], initialInstalled = [], storageKey = "greywork.installed-plugins", persist = true } = options;

  const registry = createPluginRegistry();
  const marketplace = [...remoteMarketplace];
  const installed = new Set<string>();

  const readStored = (): Set<string> => {
    if (!persist || typeof localStorage === "undefined") return new Set(initialInstalled);
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return new Set(initialInstalled);
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set(initialInstalled);
    }
  };

  for (const id of readStored()) {
    if (marketplace.some((manifest) => manifest.id === id)) {
      installed.add(id);
      const manifest = marketplace.find((manifest) => manifest.id === id);
      if (manifest) registry.register(manifest);
    }
  }

  function persistInstalled(): void {
    if (!persist || typeof localStorage === "undefined") return;
    localStorage.setItem(storageKey, JSON.stringify(Array.from(installed)));
  }

  return {
    registry,
    marketplace,
    installedIds() {
      return Array.from(installed);
    },
    install(id) {
      const manifest = marketplace.find((item) => item.id === id);
      if (!manifest || installed.has(id)) return false;
      installed.add(id);
      registry.register(manifest);
      persistInstalled();
      return true;
    },
    uninstall(id) {
      if (!installed.delete(id)) return false;
      registry.unregister(id);
      persistInstalled();
      return true;
    },
    isInstalled(id) {
      return installed.has(id);
    },
    listInstalled() {
      return marketplace.filter((manifest) => installed.has(manifest.id));
    },
  };
}
