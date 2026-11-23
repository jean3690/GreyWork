import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCloudRequest, uploadWorkspaceFile } from "../src/cloud.js";
import type { ControlPlaneRuntime } from "../src/control-plane.js";
import type { WorkspaceAccess } from "../src/workspace-access.js";
import { ControlPlaneClient, type CloudConnection } from "../src/control-plane.js";

afterEach(() => vi.unstubAllGlobals());

describe("云端接口边界", () => {
  it.each([
    ["GET", "/api/storage/objects?kind=library&limit=200"],
    ["GET", "/api/storage/objects/9223372036854775806/download"],
    ["POST", "/api/automation/tasks/at-abc123/disable"],
    ["GET", "/api/skills?q=%E6%B5%8B%E8%AF%95"],
    ["GET", "/api/download/greywork/skills/example"],
    ["GET", "/api/llm/providers"],
    ["POST", "/api/llm/keys"],
  ])("允许用户端 %s %s", (method, path) => expect(() => validateCloudRequest(method, path)).not.toThrow());
  it.each([
    ["GET", "https://evil.invalid/api/hosts"],
    ["GET", "//evil.invalid/api/hosts"],
    ["GET", "/api/admin/users"],
    ["GET", "/api/auth/me"],
    ["PATCH", "/api/storage/config"],
    ["GET", "/api/storage/objects/1/../config"],
    ["GET", "/api/storage/objects/%31"],
    ["GET", "/api/hosts?token=secret"],
    ["POST", "/api/hosts"],
    ["GET", "/api/llm/keys"],
    ["GET", "/api/llm/usage"],
    ["POST", "/v1/chat/completions"],
  ])("拒绝代理越界 %s %s", (method, path) => expect(() => validateCloudRequest(method, path)).toThrow());
  it("存储未启用时不读取本地文件", async () => {
    const connection: CloudConnection = {
      signal: new AbortController().signal,
      request: vi.fn().mockResolvedValue({ enabled: false, reason: "disabled" }),
      cleanupUpload: vi.fn(),
    };
    const runtime = { withCloudConnection: (run: (connection: CloudConnection) => Promise<unknown>) => run(connection) };
    const access = { readMedia: vi.fn() };
    await expect(
      uploadWorkspaceFile(runtime as unknown as ControlPlaneRuntime, access as unknown as WorkspaceAccess, "/root/file", "file"),
    ).rejects.toThrow("disabled");
    expect(access.readMedia).not.toHaveBeenCalled();
  });

  it("通知使用宿主 Bearer，跨字节块解析 SSE 后唤醒认领", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("event: d"));
        controller.enqueue(encoder.encode("ue\r\ndata: claim\r\n\r\nevent:ready\ndata: claim\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const wake = vi.fn();
    await new ControlPlaneClient("https://cloud.test", "host-only-token").notifications(new AbortController().signal, wake);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.test/api/hosts/me/automation/events",
      expect.objectContaining({ headers: { authorization: "Bearer host-only-token", accept: "text/event-stream" } }),
    );
  });
});
