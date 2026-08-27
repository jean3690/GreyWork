export type IntegrationProviderId = "github" | "jira" | "slack";

export interface IntegrationConfig {
  token: string;
  baseUrl?: string;
  /** GitHub repository */
  repo?: string;
  /** Jira project key */
  projectKey?: string;
  /** Slack channel */
  channel?: string;
}

export interface ExternalIssue {
  id: string;
  provider: IntegrationProviderId;
  title: string;
  status?: string;
  url?: string;
  priority?: string;
  labels?: string[];
}

export interface ExternalMessage {
  provider: IntegrationProviderId;
  channel: string;
  text: string;
  ts?: string;
}

export interface IntegrationAdapter {
  provider: IntegrationProviderId;
  connect(config: IntegrationConfig): Promise<void>;
  disconnect(): Promise<void>;
  listIssues(query?: string): Promise<ExternalIssue[]>;
  sendMessage(message: ExternalMessage): Promise<{ ok: boolean }>;
}
