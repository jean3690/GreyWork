import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  setPluginClipboardTransportForHost,
  type PluginClipboardTransport,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * clipboard 能力单测（node 环境，注入伪剪贴板）：
 *  - 授权形态：字符串形态只给 write；读必须显式声明 ops: ["read"]
 *  - 写 / 读契约（读回截断标记）；参数校验（超 64 KiB、read 带 text）不触达宿主
 *  - 审计只记长度，绝不落剪贴板内容
 *  - 无 transport → denied；宿主抛错 → error + 上抛；1 分钟 20 次限速
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

function memoryClipboard(initial = "剪贴板里的私密内容"): {
  transport: PluginClipboardTransport;
  writes: string[];
  board: { text: string };
} {
  const board = { text: initial };
  const writes: string[] = [];
  const transport: PluginClipboardTransport = {
    writeText: async (text) => {
      writes.push(text);
      board.text = text;
    },
    readText: async () => {
      if (board.text === "boom") throw new Error("clipboard unavailable");
      return board.text;
    },
  };
  return { transport, writes, board };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof memoryClipboard>;

function clipboardManifest(id: string, ops?: string[]): PluginManifest {
  return {
    id,
    name: "剪贴板插件",
    version: "1.0.0",
    requires: [ops ? { capability: "clipboard", ops } : "clipboard"],
  };
}

async function setupGranted(id = "demo.clipboard", ops?: string[]): Promise<void> {
  loader.register(clipboardManifest(id, ops));
  loader.grantCapability(id, "clipboard");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  host = memoryClipboard();
  setPluginClipboardTransportForHost(host.transport);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginClipboardTransportForHost(null);
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("clipboard 授权形态", () => {
  it("字符串形态只给 write：读被拒且不触达宿主", async () => {
    await expect(loader.callCapability("demo.clipboard", "clipboard", { op: "write", text: "hi" })).resolves.toEqual({
      written: true,
    });
    expect(host.writes).toEqual(["hi"]);

    await expect(loader.callCapability("demo.clipboard", "clipboard", { op: "read" })).rejects.toThrow(/not granted/);
    expect(
      capabilityAuditLog().some(
        (entry) => entry.capability === "clipboard" && entry.outcome === "denied" && /op not granted/.test(entry.detail ?? ""),
      ),
    ).toBe(true);
  });

  it('声明 ops: ["read"] 后可读；读回内容与截断标记', async () => {
    const reader = createCapabilityLoader();
    reader.register(clipboardManifest("demo.clipboard.reader", ["read"]));
    reader.grantCapability("demo.clipboard.reader", "clipboard");
    await reader.activate("demo.clipboard.reader");

    const short = (await reader.callCapability("demo.clipboard.reader", "clipboard", { op: "read" })) as {
      text: string;
      truncated: boolean;
    };
    expect(short).toEqual({ text: "剪贴板里的私密内容", truncated: false });

    // 读也受 64 KiB 上限：超出部分截断并标记。
    host.board.text = "x".repeat(64 * 1024 + 10);
    const long = (await reader.callCapability("demo.clipboard.reader", "clipboard", { op: "read" })) as {
      text: string;
      truncated: boolean;
    };
    expect(long.truncated).toBe(true);
    expect(long.text).toHaveLength(64 * 1024);

    // 只声明 read 的插件仍然不能写。
    await expect(reader.callCapability("demo.clipboard.reader", "clipboard", { op: "write", text: "hi" })).rejects.toThrow(/not granted/);
  });
});

describe("clipboard 参数校验与审计", () => {
  it("拒绝超 64 KiB 的写入 / read 携带 text / 未知 op，且不触达宿主", async () => {
    await expect(loader.callCapability("demo.clipboard", "clipboard", { op: "write", text: "x".repeat(64 * 1024 + 1) })).rejects.toThrow(
      /requires/,
    );
    await expect(loader.callCapability("demo.clipboard", "clipboard", { op: "read", text: "x" })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.clipboard", "clipboard", { op: "execute" })).rejects.toThrow(/requires/);
    expect(host.writes).toHaveLength(0);
  });

  it("审计只记长度，绝不落剪贴板内容", async () => {
    const reader = createCapabilityLoader();
    reader.register(clipboardManifest("demo.clipboard.privacy", ["read"]));
    reader.grantCapability("demo.clipboard.privacy", "clipboard");
    await reader.activate("demo.clipboard.privacy");

    await reader.callCapability("demo.clipboard.privacy", "clipboard", { op: "read" });
    const detail = capabilityAuditLog().find((entry) => entry.capability === "clipboard" && entry.outcome === "ok")?.detail;
    expect(detail).toBe("read · 9 chars");
    expect(detail).not.toContain("私密");
  });

  it("无 transport 时调用失败并留 denied 审计", async () => {
    setPluginClipboardTransportForHost(null);
    await expect(loader.callCapability("demo.clipboard", "clipboard", { op: "write", text: "hi" })).rejects.toThrow(/host shell/);
    expect(capabilityAuditLog().some((entry) => entry.capability === "clipboard" && entry.outcome === "denied")).toBe(true);
  });

  it("宿主抛错 → error 审计 + 错误上抛", async () => {
    const reader = createCapabilityLoader();
    reader.register(clipboardManifest("demo.clipboard.broken", ["read"]));
    reader.grantCapability("demo.clipboard.broken", "clipboard");
    await reader.activate("demo.clipboard.broken");
    host.board.text = "boom";

    await expect(reader.callCapability("demo.clipboard.broken", "clipboard", { op: "read" })).rejects.toThrow(/clipboard unavailable/);
    expect(capabilityAuditLog().some((entry) => entry.capability === "clipboard" && entry.outcome === "error")).toBe(true);
  });
});

describe("clipboard 限速", () => {
  it("1 分钟窗口内第 21 次拒绝，且不触达宿主", async () => {
    const burst = createCapabilityLoader();
    burst.register(clipboardManifest("demo.clipboard.burst"));
    burst.grantCapability("demo.clipboard.burst", "clipboard");
    await burst.activate("demo.clipboard.burst");

    for (let index = 0; index < 20; index += 1) {
      await burst.callCapability("demo.clipboard.burst", "clipboard", { op: "write", text: `第 ${index} 次` });
    }
    const before = host.writes.length;
    await expect(burst.callCapability("demo.clipboard.burst", "clipboard", { op: "write", text: "overflow" })).rejects.toThrow(
      /rate limit/,
    );
    expect(host.writes).toHaveLength(before);
  });
});
