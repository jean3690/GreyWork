// AcpAgentAdapter 组合验证：以 @greywork/acp 的 fake transport 跑通 startAgent，
// 并保持 provider 标识。（原位于 acp 包测试；为断开 acp ↔ integrations
// 循环依赖迁移至此——integrations 本就反向依赖 acp。）
import { describe, expect, it } from "vitest";
import { createAcpClient, type AcpEventEnvelope, type AcpTransport, type PermissionTier } from "@greywork/acp";
import { createAcpAgentAdapter } from "./acp-adapter";

function fakeTransport(): AcpTransport & { events: AcpEventEnvelope[] } {
  const events: AcpEventEnvelope[] = [];
  const listeners = new Set<(event: AcpEventEnvelope) => void>();
  return {
    id: "tauri-ipc",
    events,
    async startAgent(_cmd: string, _tier: PermissionTier) {
      events.push({ kind: "started", payload: { handle: 1 } });
      return 1;
    },
    async openSession() {
      return { sessionId: "sess-fake", configOptions: [] };
    },
    async setSessionConfig(_handle, configId, value) {
      return [{ id: configId, name: "Model", type: "select", currentValue: value }];
    },
    async prompt(_handle, text) {
      events.push({ kind: "session-update", payload: { text } });
      for (const listener of listeners) listener(events[events.length - 1]!);
      return { stopReason: "end_turn" };
    },
    async stop() {
      events.push({ kind: "stopped", payload: {} });
    },
    async respondPermission(requestId, optionId) {
      events.push({ kind: "permission-resolved", payload: { requestId, optionId } });
    },
    async list() {
      return [];
    },
    async onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe("AcpAgentAdapter", () => {
  it("composes a transport and keeps the acp provider identity", async () => {
    const adapter = createAcpAgentAdapter(createAcpClient(fakeTransport()));
    expect(adapter.provider).toBe("acp");
    expect(adapter.isAvailable()).toBe(true);
    const handle = await adapter.startAgent("node mock.mjs", "auto");
    expect(handle).toBe(1);
    const opened = await adapter.openSession(handle, "/tmp");
    expect(opened.sessionId).toBe("sess-fake");
    const options = await adapter.setSessionConfig(handle, "model", "mock-slow");
    expect(options[0]?.currentValue).toBe("mock-slow");
  });
});
