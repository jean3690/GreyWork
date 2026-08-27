import { invoke } from "@tauri-apps/api/core";
import type { WebSearchProviderConfig } from "./types";

/** 归一化搜索结果（与 Rust web_search.rs 的 WebSearchHit 对应）。 */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchTarget {
  providerId: string;
  endpoint: string;
  apiKeyEnv?: string;
}

/** 选择用于真实网页搜索的供应商：启用且 endpoint 已配置。 */
export function selectWebSearchProvider(providers: WebSearchProviderConfig[]): WebSearchProviderConfig | null {
  return providers.find((provider) => provider.enabled && !!provider.endpoint?.trim()) ?? null;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface WebSearchClient {
  /** 仅桌面端可直连（宿主代理 + 密钥环境变量解析）；web 运行时不可用。 */
  isAvailable(): boolean;
  search(target: WebSearchTarget, query: string, maxResults?: number): Promise<WebSearchHit[]>;
}

/** 桌面端经 Tauri IPC 调 Rust 宿主（web_search.rs）；密钥不经过渲染端。 */
export function createWebSearchClient(): WebSearchClient {
  return {
    isAvailable: () => isTauriRuntime(),
    search: (target, query, maxResults) => {
      if (!isTauriRuntime()) {
        return Promise.reject(new Error("web search requires the desktop runtime (Tauri host)"));
      }
      return invoke<WebSearchHit[]>("web_search", {
        providerId: target.providerId,
        endpoint: target.endpoint,
        apiKeyEnv: target.apiKeyEnv ?? "",
        query,
        maxResults,
      });
    },
  };
}
