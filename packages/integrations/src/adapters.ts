import type { ExternalIssue, ExternalMessage, IntegrationAdapter, IntegrationConfig, IntegrationProviderId } from "./types";

async function wait(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockAdapter(provider: IntegrationProviderId, sampleIssues: ExternalIssue[]): IntegrationAdapter {
  let connected = false;
  let config: IntegrationConfig | undefined;
  return {
    provider,
    async connect(next) {
      connected = true;
      config = next;
    },
    async disconnect() {
      connected = false;
      config = undefined;
    },
    async listIssues(query) {
      if (!connected) throw new Error(`${provider}: not connected`);
      await wait();
      const lower = query?.toLowerCase();
      if (!lower) return sampleIssues;
      return sampleIssues.filter(
        (issue) => issue.title.toLowerCase().includes(lower) || issue.labels?.some((label) => label.toLowerCase().includes(lower)),
      );
    },
    async sendMessage(_message: ExternalMessage) {
      if (!connected) throw new Error(`${provider}: not connected`);
      await wait();
      return { ok: !!config };
    },
  };
}

export const githubIssues: ExternalIssue[] = [
  {
    id: "gh-42",
    provider: "github",
    title: "支持 3D Tiles 本地加载",
    status: "open",
    url: "https://github.com/greywork/greywork/issues/42",
    labels: ["spatial", "p1"],
  },
  {
    id: "gh-47",
    provider: "github",
    title: "增加 Agent 循环限流策略",
    status: "in-progress",
    url: "https://github.com/greywork/greywork/issues/47",
    labels: ["agents", "p2"],
  },
];

export const jiraIssues: ExternalIssue[] = [
  { id: "OF-128", provider: "jira", title: "MBTiles 图层渲染优化", status: "To Do", priority: "High", labels: ["gis"] },
  { id: "OF-131", provider: "jira", title: "DuckDB-WASM 空间索引", status: "In Progress", priority: "Highest", labels: ["analytics"] },
];

export function createGitHubAdapter(): IntegrationAdapter {
  return createMockAdapter("github", githubIssues);
}

export function createJiraAdapter(): IntegrationAdapter {
  return createMockAdapter("jira", jiraIssues);
}

export function createSlackAdapter(): IntegrationAdapter {
  return createMockAdapter("slack", [
    { id: "slack-1", provider: "slack", title: "GreyWork: 发布 0.2.0 通知", status: "sent", labels: ["announcement"] },
  ]);
}
