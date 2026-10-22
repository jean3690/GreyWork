import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { workerPrelude, isPatch } from "@/plugins/code-runtime";

/**
 * demo.brief worker 单测：直接加载仓库里的真实插件代码（不复制一份），
 * 用真实 prelude 跑在模拟 worker 作用域里，宿主侧用假能力表记录调用。
 *
 * 覆盖：四能力全链路（顺序 + 参数 + 返回字段）、显式路径跳过 roots、
 * 无授权根提前收尾、读/摘要/复制各步失败时的降级行为、长文件摘录截断、copy 动作。
 */

const BRIEF_CODE = readFileSync(fileURLToPath(new URL("../../../../../plugin-market/packages/demo.brief.js", import.meta.url)), "utf8");

const EMPTY_STATE = { path: "", summary: "", artifact: "", steps: "", status: "尚未运行" };

interface HostCall {
  capability: string;
  args: Record<string, unknown>;
}

type Host = (capability: string, args: Record<string, unknown>) => unknown;

function createBriefWorker(host: Host) {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const calls: HostCall[] = [];

  const deliver = (message: unknown): void => {
    for (const listener of [...listeners]) listener({ data: message });
  };

  const scope: Record<string, unknown> = {
    postMessage: (message: unknown) => {
      const data = message as {
        type?: string;
        requestId?: number;
        capability?: string;
        args?: Record<string, unknown>;
      };
      if (data?.type === "result") deliver(message);
      if (data?.type === "host-call") {
        calls.push({ capability: String(data.capability), args: data.args ?? {} });
        Promise.resolve()
          .then(() => host(String(data.capability), data.args ?? {}))
          .then(
            (result) => deliver({ type: "host-result", requestId: data.requestId, result }),
            (error) =>
              deliver({
                type: "host-result",
                requestId: data.requestId,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
      }
    },
    addEventListener: (_type: string, listener: (event: { data: unknown }) => void) => listeners.push(listener),
  };

  const factory = new Function(
    "scope",
    [
      "const factoryInner = (function () {",
      "  return function (self, globalThis) {",
      "    with (self) {",
      workerPrelude,
      BRIEF_CODE,
      "    }",
      "  };",
      "})();",
      "return factoryInner;",
    ].join("\n"),
  );
  // factory(scope) 只返回内层函数，必须再调一次才会执行 prelude + 插件代码。
  (factory as (s: Record<string, unknown>) => (self: Record<string, unknown>, g: Record<string, unknown>) => void)(scope)(scope, scope);

  function invoke(handler: string, state: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown> | undefined>();
    const waitForResult = (event: { data: unknown }): void => {
      const data = event.data as { type?: string; patch?: unknown; error?: unknown };
      if (data?.type !== "result") return;
      const index = listeners.indexOf(waitForResult);
      if (index >= 0) listeners.splice(index, 1);
      if (data.error !== undefined) reject(new Error(String(data.error)));
      else resolve(data.patch as Record<string, unknown> | undefined);
    };
    listeners.push(waitForResult);
    for (const listener of [...listeners]) {
      if (listener !== waitForResult) {
        listener({ data: { type: "invoke", requestId: -1, handler, state } });
      }
    }
    return promise;
  }

  return { invoke, calls };
}

/** 默认「一切顺利」的假宿主：README 内容、摘要、产物路径、剪贴板都固定。 */
function happyHost(overrides: Record<string, Host> = {}): { host: Host; calls: HostCall[] } {
  const calls: HostCall[] = [];
  const host: Host = (capability, args) => {
    calls.push({ capability, args });
    const override = overrides[capability];
    if (override) return override(capability, args);
    if (capability === "workspace.read" && args.op === "roots") {
      return { roots: [{ path: "/work/app", name: "app" }] };
    }
    if (capability === "workspace.read") {
      return {
        path: args.path,
        name: "README.md",
        bytes: 40,
        data: "# GreyWork\n\n本地优先的工作台。\n",
        truncated: false,
      };
    }
    if (capability === "llm.chat") return { text: "本地优先的工作台。", model: "gpt-4o-mini" };
    if (capability === "artifacts.publish") {
      return { id: "a1", name: "README.md-速览", path: "plugins/demo.brief/1-readme.md", format: "md" };
    }
    if (capability === "clipboard") return undefined;
    throw new Error("unexpected capability: " + capability);
  };
  return { host, calls };
}

describe("demo.brief 四能力串联", () => {
  it("全链路：roots → 读文件 → 摘要 → 发布 → 复制，参数与补丁都合法", async () => {
    const { host, calls } = happyHost();
    const worker = createBriefWorker(host);
    const patch = await worker.invoke("brief", { ...EMPTY_STATE });

    expect(isPatch(patch)).toBe(true);
    expect(patch).toMatchObject({
      path: "/work/app/README.md",
      summary: "本地优先的工作台。",
      artifact: "plugins/demo.brief/1-readme.md",
    });
    expect(patch?.steps).toBe("✓ 列授权根 · ✓ 读文件 · ✓ 模型摘要 · ✓ 发布产物 · ✓ 复制摘要");
    expect(patch?.status).toBe("四步全通：摘要已发布并在剪贴板");

    expect(calls.map((call) => call.capability)).toEqual([
      "workspace.read",
      "workspace.read",
      "llm.chat",
      "artifacts.publish",
      "clipboard",
    ]);
    // 读的是授权根拼出来的绝对路径。
    expect(calls[1].args).toEqual({ op: "read", path: "/work/app/README.md" });
    // 摘要请求只带 prompt / system，不带模型密钥之类的东西。
    expect(Object.keys(calls[2].args).sort()).toEqual(["prompt", "system"]);
    expect(String(calls[2].args.prompt)).toContain("本地优先的工作台。");
    // 产物是 Markdown，正文含标题、摘要与摘录三段。
    expect(calls[3].args.format).toBe("md");
    const data = String(calls[3].args.data);
    expect(data).toContain("# README.md 速览");
    expect(data).toContain("## 摘要");
    expect(data).toContain("## 原文摘录");
    expect(data).toContain("本地优先的工作台。");
    // 剪贴板只写摘要，不是整份产物。
    expect(calls[4].args).toEqual({ op: "write", text: "本地优先的工作台。" });
  });

  it("显式填了路径就不再问 roots", async () => {
    const { host, calls } = happyHost();
    const worker = createBriefWorker(host);
    const patch = await worker.invoke("brief", { ...EMPTY_STATE, path: "/work/app/docs/GUIDE.md" });

    expect(calls[0]).toEqual({ capability: "workspace.read", args: { op: "read", path: "/work/app/docs/GUIDE.md" } });
    expect(calls.some((call) => call.args.op === "roots")).toBe(false);
    expect(patch?.path).toBe("/work/app/docs/GUIDE.md");
  });

  it("没有授权根时提前收尾，不会去读文件或调模型", async () => {
    const { host, calls } = happyHost({
      "workspace.read": (_capability, args) => (args.op === "roots" ? { roots: [] } : { data: "" }),
    });
    const worker = createBriefWorker(host);
    const patch = await worker.invoke("brief", { ...EMPTY_STATE });

    expect(calls).toHaveLength(1);
    expect(patch?.steps).toBe("✓ 列授权根 · ✗ 没有已授权的工作区");
    expect(patch?.status).toBe("先在工作区打开一个目录，或手动填一个授权根内的路径");
    expect(patch?.summary).toBeUndefined();
  });

  it("读取失败就停在读文件，后续能力一次都不调", async () => {
    const { host, calls } = happyHost({
      "workspace.read": (_capability, args) => {
        if (args.op === "roots") return { roots: [{ path: "/work/app", name: "app" }] };
        throw new Error("workspace.read path is not an authorized existing path");
      },
    });
    const worker = createBriefWorker(host);
    const patch = await worker.invoke("brief", { ...EMPTY_STATE });

    expect(calls.map((call) => call.capability)).toEqual(["workspace.read", "workspace.read"]);
    expect(patch?.steps).toBe("✓ 列授权根 · ✗ 读文件");
    expect(String(patch?.status)).toBe("读取失败：workspace.read path is not an authorized existing path");
  });

  it("模型失败就不发布产物，步骤流水指出是哪一步", async () => {
    const { host, calls } = happyHost({
      "llm.chat": () => {
        throw new Error("llm.chat model not allowed: gpt-4o");
      },
    });
    const worker = createBriefWorker(host);
    const patch = await worker.invoke("brief", { ...EMPTY_STATE });

    expect(calls.some((call) => call.capability === "artifacts.publish")).toBe(false);
    expect(patch?.steps).toBe("✓ 列授权根 · ✓ 读文件 · ✗ 模型摘要");
    expect(String(patch?.status)).toBe("摘要失败：llm.chat model not allowed: gpt-4o");
  });

  it("复制失败不影响已发布的产物，状态里说清楚", async () => {
    const { host } = happyHost({
      clipboard: () => {
        throw new Error("clipboard op not granted: write");
      },
    });
    const worker = createBriefWorker(host);
    const patch = await worker.invoke("brief", { ...EMPTY_STATE });

    expect(patch?.artifact).toBe("plugins/demo.brief/1-readme.md");
    expect(patch?.steps).toBe("✓ 列授权根 · ✓ 读文件 · ✓ 模型摘要 · ✓ 发布产物 · ✗ 复制摘要");
    expect(String(patch?.status)).toContain("复制失败");
  });

  it("长文件只把前 1200 字送进模型，摘录带省略号", async () => {
    const long = "长".repeat(5000);
    const { host, calls } = happyHost({
      "workspace.read": (_capability, args) =>
        args.op === "roots"
          ? { roots: [{ path: "/work/app", name: "app" }] }
          : { path: args.path, name: "README.md", bytes: 15000, data: long, truncated: true },
    });
    const worker = createBriefWorker(host);
    await worker.invoke("brief", { ...EMPTY_STATE });

    const prompt = String(calls[2].args.prompt);
    expect(prompt.length).toBeLessThanOrEqual(1400);
    expect(prompt).toContain("…");
    expect(prompt).not.toContain(long);
  });

  it("copy 动作：有摘要时写剪贴板，空摘要时不发调用", async () => {
    const { host, calls } = happyHost();
    const worker = createBriefWorker(host);

    const copied = await worker.invoke("copy", { ...EMPTY_STATE, summary: "本地优先的工作台。" });
    expect(calls).toEqual([{ capability: "clipboard", args: { op: "write", text: "本地优先的工作台。" } }]);
    expect(copied?.status).toBe("已复制 9 字");

    const empty = await worker.invoke("copy", { ...EMPTY_STATE });
    expect(calls).toHaveLength(1);
    expect(empty?.status).toBe("还没有摘要，先跑一次「生成速览」");
  });
});
