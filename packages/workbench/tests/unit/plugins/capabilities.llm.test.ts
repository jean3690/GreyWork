import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  setPluginLlmChatTransportForHost,
  type PluginLlmChatRequest,
  type PluginLlmChatTransport,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * llm.chat 能力单测（node 环境，注入宿主伪传输）：
 *  - 默认模型 = 白名单首个；显式 model 必须在白名单内；system 原样透传
 *  - 参数校验（空 prompt / 超长 prompt / 超长 system / 空 model）不触达宿主
 *  - 缺 models 声明的 manifest 直接拒绝（不回落「不限模型」）
 *  - 无宿主 transport → denied 审计；宿主抛错 → error 审计 + 上抛
 *  - 滑动窗口限速（20 次 / 10 分钟，按插件隔离）
 *
 * 宿主侧（Rust llm_chat_complete → chat_complete）只做聚合补全，凭证由渲染端按当前设置
 * 解析成「环境变量名」传入；插件永远看不到明文 key。
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

/** 内存宿主：还原 llm_chat_complete 的返回形态（纯文本）。 */
function memoryHost(): { transport: PluginLlmChatTransport; calls: PluginLlmChatRequest[] } {
  const calls: PluginLlmChatRequest[] = [];
  const transport: PluginLlmChatTransport = async (request) => {
    calls.push(request);
    if (request.prompt.includes("boom")) throw new Error("upstream 429");
    return { text: `echo:${request.prompt}`, model: request.model };
  };
  return { transport, calls };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof memoryHost>;

function llmManifest(id = "demo.llm", models: string[] = ["gpt-4o-mini", "qwen2.5:7b"]): PluginManifest {
  return { id, name: "模型插件", version: "1.0.0", requires: [{ capability: "llm.chat", models }] };
}

async function setupGranted(id = "demo.llm", models?: string[]): Promise<void> {
  loader.register(llmManifest(id, models));
  loader.grantCapability(id, "llm.chat");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  host = memoryHost();
  setPluginLlmChatTransportForHost(host.transport);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginLlmChatTransportForHost(null);
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("llm.chat 基本契约", () => {
  it("缺省用白名单首个模型；显式 model 走白名单；system 原样透传", async () => {
    const first = (await loader.callCapability("demo.llm", "llm.chat", { prompt: "总结一下" })) as {
      text: string;
      model: string;
    };
    expect(first).toEqual({ text: "echo:总结一下", model: "gpt-4o-mini" });

    const second = (await loader.callCapability("demo.llm", "llm.chat", {
      prompt: "分类",
      system: "你是分类器",
      model: "qwen2.5:7b",
    })) as { text: string; model: string };
    expect(second.model).toBe("qwen2.5:7b");

    expect(host.calls).toEqual([
      { pluginId: "demo.llm", model: "gpt-4o-mini", system: undefined, prompt: "总结一下" },
      { pluginId: "demo.llm", model: "qwen2.5:7b", system: "你是分类器", prompt: "分类" },
    ]);
  });

  it("审计记录成功调用（模型 + 正文字数）", async () => {
    await loader.callCapability("demo.llm", "llm.chat", { prompt: "hi" });
    const entry = capabilityAuditLog().find((item) => item.capability === "llm.chat" && item.outcome === "ok");
    expect(entry?.detail).toBe("gpt-4o-mini · 7 chars");
  });
});

describe("llm.chat 参数校验", () => {
  it("拒绝空 prompt / 超长 prompt / 超长 system / 空 model，且不触达宿主", async () => {
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "   " })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "x".repeat(8001) })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "hi", system: "s".repeat(2001) })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "hi", model: " " })).rejects.toThrow(/requires/);
    await expect(loader.callCapability("demo.llm", "llm.chat", {})).rejects.toThrow(/requires/);
    expect(host.calls).toHaveLength(0);
  });

  it("白名单外的模型直接拒绝（不触达宿主，留 denied 审计）", async () => {
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "hi", model: "gpt-4o" })).rejects.toThrow(/not allowed/);
    expect(host.calls).toHaveLength(0);
    expect(capabilityAuditLog().some((entry) => entry.capability === "llm.chat" && entry.outcome === "denied")).toBe(true);
  });

  it("manifest 只声明字符串形态（无 models）→ 拒绝，不回落不限模型", async () => {
    const loose = createCapabilityLoader();
    loose.register({ id: "demo.llm.loose", name: "宽松", version: "1.0.0", requires: ["llm.chat"] });
    loose.grantCapability("demo.llm.loose", "llm.chat");
    await loose.activate("demo.llm.loose");
    await expect(loose.callCapability("demo.llm.loose", "llm.chat", { prompt: "hi" })).rejects.toThrow(/models allowlist/);
    expect(host.calls).toHaveLength(0);
  });
});

describe("llm.chat 宿主可用性与审计", () => {
  it("无宿主 transport 时调用失败并留 denied 审计", async () => {
    setPluginLlmChatTransportForHost(null);
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "hi" })).rejects.toThrow(/desktop or server host/);
    expect(
      capabilityAuditLog().some((entry) => entry.plugin === "demo.llm" && entry.capability === "llm.chat" && entry.outcome === "denied"),
    ).toBe(true);
  });

  it("宿主抛错 → error 审计 + 错误上抛", async () => {
    await expect(loader.callCapability("demo.llm", "llm.chat", { prompt: "boom" })).rejects.toThrow(/429/);
    expect(capabilityAuditLog().some((entry) => entry.capability === "llm.chat" && entry.outcome === "error")).toBe(true);
  });
});

describe("llm.chat 限速", () => {
  it("10 分钟窗口内第 21 次拒绝，且不触达宿主", async () => {
    const guarded = createCapabilityLoader();
    guarded.register(llmManifest("demo.llm.burst"));
    guarded.grantCapability("demo.llm.burst", "llm.chat");
    await guarded.activate("demo.llm.burst");

    for (let index = 0; index < 20; index += 1) {
      await guarded.callCapability("demo.llm.burst", "llm.chat", { prompt: `第 ${index} 次` });
    }
    const before = host.calls.length;
    await expect(guarded.callCapability("demo.llm.burst", "llm.chat", { prompt: "超出" })).rejects.toThrow(/rate limit/);
    expect(host.calls).toHaveLength(before);
  });
});

describe("llm.chat 门禁", () => {
  it("未激活调用被拒；revoke 后即时拒绝且不再触达宿主", async () => {
    const guarded = createCapabilityLoader();
    guarded.register(llmManifest("demo.llm.quiet"));
    await expect(guarded.callCapability("demo.llm.quiet", "llm.chat", { prompt: "hi" })).rejects.toThrow(/not active/);

    guarded.grantCapability("demo.llm.quiet", "llm.chat");
    await guarded.activate("demo.llm.quiet");
    await expect(guarded.callCapability("demo.llm.quiet", "llm.chat", { prompt: "hi" })).resolves.toMatchObject({
      model: "gpt-4o-mini",
    });

    guarded.revokeCapability("demo.llm.quiet", "llm.chat");
    const before = host.calls.length;
    await expect(guarded.callCapability("demo.llm.quiet", "llm.chat", { prompt: "hi" })).rejects.toThrow(/revoked/);
    expect(host.calls).toHaveLength(before);
  });
});
