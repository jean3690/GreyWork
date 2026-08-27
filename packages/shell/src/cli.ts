import type { CliIntegration, CliSession, CliSessionManager } from "./types";

export function createDefaultCliIntegrations(): CliIntegration[] {
  return [
    { id: "opencode", kind: "opencode", name: "opencode", command: "opencode", args: ["run"], available: true },
    { id: "claude-code", kind: "claude-code", name: "Claude Code", command: "claude", args: [], available: true },
    { id: "pi", kind: "pi", name: "pi (pia)", command: "pi", args: [], available: true },
    { id: "custom", kind: "custom", name: "自定义 CLI", command: "", args: [], available: false },
  ];
}

export function createCliSessionManager(): CliSessionManager {
  const sessions: CliSession[] = [
    { id: "cli-1", cliId: "opencode", title: "opencode · 空间态势分析", status: "running", startedAt: new Date().toISOString() },
    { id: "cli-2", cliId: "claude-code", title: "claude · GIS 数据核对", status: "idle", startedAt: new Date().toISOString() },
    { id: "cli-3", cliId: "pi", title: "pi · 插件市场调研", status: "done", startedAt: new Date().toISOString() },
  ];
  return {
    list() {
      return [...sessions];
    },
    start(cliId, title = "未命名 CLI 会话") {
      const session: CliSession = {
        id: "cli-" + Math.random().toString(36).slice(2, 7),
        cliId,
        title,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      sessions.unshift(session);
      return session;
    },
    stop(id) {
      const session = sessions.find((item) => item.id === id);
      if (!session) return false;
      session.status = "done";
      return true;
    },
  };
}
