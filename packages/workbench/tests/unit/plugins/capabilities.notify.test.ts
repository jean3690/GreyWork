import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  resetNotifyRateLimitForTest,
  setPluginNotifyTransportForHost,
  type PluginNotifyTransport,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * notify 能力单测（node 环境，注入宿主伪传输）：
 *  - 基本契约：返回值 / transport 收到的 pluginId/title/body / 首尾空白裁剪
 *  - 参数校验：空标题/正文、超长（按码点）、控制字符（标题全禁、正文仅放行换行）
 *  - 无宿主 transport 即失败并留 denied 审计
 *  - 限速：每分钟 10 条，第 11 条 denied
 *  - 宿主抛错 → error 审计 + 错误上抛
 *  - 门禁（未激活 / revoke 即时拒绝）
 */

const storageHolder = globalThis as { localStorage?: Storage };

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

interface NotifyCall {
  pluginId: string;
  title: string;
  body: string;
}

function recordingTransport(): {
  transport: PluginNotifyTransport;
  calls: NotifyCall[];
  result: (request: NotifyCall) => { title: string; body: string };
} {
  const calls: NotifyCall[] = [];
  const result = (request: NotifyCall) => ({ title: `[${request.pluginId}] ${request.title}`, body: request.body });
  const transport: PluginNotifyTransport = async (request) => {
    calls.push({ ...request });
    return result(request);
  };
  return { transport, calls, result };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof recordingTransport>;

function notifyManifest(id = "demo.notify"): PluginManifest {
  return { id, name: "通知插件", version: "1.0.0", requires: ["notify"] };
}

async function setupGranted(id = "demo.notify"): Promise<void> {
  loader.register(notifyManifest(id));
  loader.grantCapability(id, "notify");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  resetNotifyRateLimitForTest();
  host = recordingTransport();
  setPluginNotifyTransportForHost(host.transport);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginNotifyTransportForHost(null);
  resetNotifyRateLimitForTest();
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("notify 基本契约", () => {
  it("调用后返回归属后的文案，transport 收到 trim 后的 title/body 与 pluginId", async () => {
    const result = (await loader.callCapability("demo.notify", "notify", {
      title: "  构建完成  ",
      body: "  所有测试通过  ",
    })) as { sent: boolean; title: string; body: string };

    expect(result.sent).toBe(true);
    expect(result.title).toBe("[demo.notify] 构建完成");
    expect(result.body).toBe("所有测试通过");
    expect(host.calls).toEqual([{ pluginId: "demo.notify", title: "构建完成", body: "所有测试通过" }]);
  });

  it("两个插件各自同名调用，transport 收到各自 pluginId（归属隔离）", async () => {
    const loaderAB = createCapabilityLoader();
    loaderAB.register(notifyManifest("demo.notify.a"));
    loaderAB.register(notifyManifest("demo.notify.b"));
    loaderAB.grantCapability("demo.notify.a", "notify");
    loaderAB.grantCapability("demo.notify.b", "notify");
    await loaderAB.activate("demo.notify.a");
    await loaderAB.activate("demo.notify.b");

    await loaderAB.callCapability("demo.notify.a", "notify", { title: "A", body: "x" });
    await loaderAB.callCapability("demo.notify.b", "notify", { title: "B", body: "y" });

    expect(host.calls.map((call) => [call.pluginId, call.title])).toEqual([
      ["demo.notify.a", "A"],
      ["demo.notify.b", "B"],
    ]);
  });
});

describe("notify 参数校验", () => {
  it("空标题 / 空正文 / 缺字段 / 超长 / 控制字符一律拒绝且不触达宿主", async () => {
    const tooLongTitle = "资".repeat(65);
    const tooLongBody = "文".repeat(241);
    for (const args of [
      { title: "  ", body: "x" },
      { title: "t" },
      { title: "t", body: 42 },
      { title: tooLongTitle, body: "x" },
      { title: "t", body: tooLongBody },
      { title: "bad\nnewline", body: "x" },
      { title: "t", body: "tab\there" },
    ]) {
      await expect(loader.callCapability("demo.notify", "notify", args as never)).rejects.toThrow(/notify requires/);
    }
    expect(host.calls).toHaveLength(0);
  });

  it("正文放行换行；64 码点标题可发，65 拒绝", async () => {
    await loader.callCapability("demo.notify", "notify", { title: "提醒", body: "第一行\n第二行" });
    await loader.callCapability("demo.notify", "notify", { title: "资".repeat(64), body: "x" });
    await expect(loader.callCapability("demo.notify", "notify", { title: "资".repeat(65), body: "x" })).rejects.toThrow(/notify requires/);
    expect(host.calls).toHaveLength(2);
  });
});

describe("notify 宿主可用性与限速", () => {
  it("无宿主 transport 时调用失败并留 denied 审计", async () => {
    setPluginNotifyTransportForHost(null);
    await expect(loader.callCapability("demo.notify", "notify", { title: "t", body: "b" })).rejects.toThrow(/desktop host/);
    expect(
      capabilityAuditLog().some((entry) => entry.plugin === "demo.notify" && entry.capability === "notify" && entry.outcome === "denied"),
    ).toBe(true);
  });

  it("每分钟第 11 条被限速拒绝（denied 审计），重置后恢复", async () => {
    for (let index = 0; index < 10; index++) {
      await loader.callCapability("demo.notify", "notify", { title: `t${index}`, body: "b" });
    }
    await expect(loader.callCapability("demo.notify", "notify", { title: "t11", body: "b" })).rejects.toThrow(/rate limit exceeded/);
    expect(
      capabilityAuditLog().some(
        (entry) => entry.capability === "notify" && entry.outcome === "denied" && entry.detail?.includes("rate limit"),
      ),
    ).toBe(true);

    resetNotifyRateLimitForTest();
    await expect(loader.callCapability("demo.notify", "notify", { title: "again", body: "b" })).resolves.toMatchObject({ sent: true });
  });

  it("宿主抛错 → error 审计 + 错误上抛", async () => {
    setPluginNotifyTransportForHost(async () => {
      throw new Error("notification plugin unavailable");
    });
    await expect(loader.callCapability("demo.notify", "notify", { title: "t", body: "b" })).rejects.toThrow(
      /notification plugin unavailable/,
    );
    expect(capabilityAuditLog().some((entry) => entry.capability === "notify" && entry.outcome === "error")).toBe(true);
  });

  it("成功调用留 ok 审计（detail 为归属后的标题）", async () => {
    await loader.callCapability("demo.notify", "notify", { title: "构建完成", body: "b" });
    expect(
      capabilityAuditLog().some(
        (entry) =>
          entry.plugin === "demo.notify" &&
          entry.capability === "notify" &&
          entry.outcome === "ok" &&
          entry.detail === "[demo.notify] 构建完成",
      ),
    ).toBe(true);
  });
});

describe("notify 门禁", () => {
  it("未声明 / 未激活调用被拒；revoke 后即时拒绝且不触达宿主", async () => {
    const loaderDeny = createCapabilityLoader();
    loaderDeny.register(notifyManifest("demo.notify.quiet"));
    await expect(loaderDeny.callCapability("demo.notify.quiet", "notify", { title: "t", body: "b" })).rejects.toThrow(/not active/);

    loaderDeny.grantCapability("demo.notify.quiet", "notify");
    loaderDeny.activate("demo.notify.quiet");
    await expect(loaderDeny.callCapability("demo.notify.quiet", "notify", { title: "t", body: "b" })).resolves.toMatchObject({
      sent: true,
    });

    const callsBeforeRevoke = host.calls.length;
    loaderDeny.revokeCapability("demo.notify.quiet", "notify");
    await expect(loaderDeny.callCapability("demo.notify.quiet", "notify", { title: "t", body: "b" })).rejects.toThrow(/revoked/);
    expect(host.calls).toHaveLength(callsBeforeRevoke);
  });
});
