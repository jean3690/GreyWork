// HostCommandTransport 契约：命令名与参数形状必须与 `acp_host` 的命令表逐字对齐。
// 名字或字段错一个字符，界面上就是「点了没反应」——这里把它们钉住。
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => ({})),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {}),
}));

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  invoke: mocks.invoke,
  listen: mocks.listen,
}));

import { HostCommandTransport } from "../../src/host-transport";

afterEach(() => {
  vi.clearAllMocks();
});

describe("HostCommandTransport", () => {
  it("startAgent：命令名与 (agentCmd, tier, env) 形状", async () => {
    mocks.invoke.mockResolvedValueOnce(7);
    const transport = new HostCommandTransport();
    await expect(transport.startAgent("opencode acp", "workspace", { KEY: "v" })).resolves.toBe(7);
    expect(mocks.invoke).toHaveBeenCalledWith("acp_start", {
      agentCmd: "opencode acp",
      tier: "workspace",
      env: { KEY: "v" },
    });
  });

  it("openSession / loadSession：命令名与 (handle, cwd, mcpServers) 形状", async () => {
    mocks.invoke.mockResolvedValue({ sessionId: "s1" });
    const transport = new HostCommandTransport();
    await transport.openSession(1, "/ws");
    await transport.loadSession(1, "/ws", "s0", []);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "acp_new_session", { handle: 1, cwd: "/ws", mcpServers: undefined });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "acp_load_session", { handle: 1, cwd: "/ws", sessionId: "s0", mcpServers: [] });
  });

  it("closeSession：命令名与 (handle, sessionId) 形状", async () => {
    mocks.invoke.mockResolvedValueOnce(true);
    const transport = new HostCommandTransport();
    await expect(transport.closeSession(1, "s0")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("acp_close_session", { handle: 1, sessionId: "s0" });
  });

  it("prompt / stop / cancelSession / respondPermission：命令名与入参形状", async () => {
    mocks.invoke.mockResolvedValue({ turnId: 3 });
    const transport = new HostCommandTransport();
    await transport.prompt(1, "跑一下");
    await transport.stop(1, 3);
    await transport.cancelSession(1, "s1");
    await transport.respondPermission(9, "allow-once");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "acp_send", { handle: 1, text: "跑一下", units: [] });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "acp_stop", { handle: 1, turnId: 3 });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "acp_cancel_session", { handle: 1, sessionId: "s1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "acp_permission_respond", { requestId: 9, optionId: "allow-once" });
  });

  it("setSessionConfig：回传 configOptions（缺字段归空数组）", async () => {
    mocks.invoke.mockResolvedValueOnce({ configOptions: [{ id: "model" }] });
    mocks.invoke.mockResolvedValueOnce({});
    const transport = new HostCommandTransport();
    await expect(transport.setSessionConfig(1, "model", "fast")).resolves.toEqual([{ id: "model" }]);
    await expect(transport.setSessionConfig(1, "model", "fast")).resolves.toEqual([]);
    expect(mocks.invoke).toHaveBeenCalledWith("acp_set_config", { handle: 1, configId: "model", value: "fast" });
  });

  it("setSessionMode：命令名与 (handle, modeId) 形状", async () => {
    const transport = new HostCommandTransport();
    await transport.setSessionMode(1, "plan");
    expect(mocks.invoke).toHaveBeenCalledWith("acp_set_mode", { handle: 1, modeId: "plan" });
  });

  it("onEvent：订阅 acp://event 并解包 payload，解绑转发", async () => {
    const unlisten = vi.fn();
    mocks.listen.mockResolvedValueOnce(unlisten);
    const transport = new HostCommandTransport();
    const listener = vi.fn();
    const stop = await transport.onEvent(listener);

    const handler = mocks.listen.mock.calls[0][1];
    handler({ payload: { kind: "started" } });
    expect(listener).toHaveBeenCalledWith({ kind: "started" });

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
