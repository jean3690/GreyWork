import { createGitHubAdapter, createJiraAdapter, createSlackAdapter } from "./adapters";
import type { IntegrationAdapter, IntegrationProviderId } from "./types";

export interface IntegrationHub {
  get(provider: IntegrationProviderId): IntegrationAdapter | undefined;
  list(): IntegrationAdapter[];
}

export function createIntegrationHub(): IntegrationHub {
  const adapters = new Map<IntegrationProviderId, IntegrationAdapter>();
  for (const adapter of [createGitHubAdapter(), createJiraAdapter(), createSlackAdapter()]) {
    adapters.set(adapter.provider, adapter);
  }
  return {
    get(provider) {
      return adapters.get(provider);
    },
    list() {
      return Array.from(adapters.values());
    },
  };
}
