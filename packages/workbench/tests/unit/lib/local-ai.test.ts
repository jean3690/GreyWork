// 本地 AI 注入逻辑的契约：检索上下文组装、语音转写、以及「未启用/无命中/出错都不拦回合」。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "@greywork/llm";
import type { ModelProviderConfig } from "@greywork/shell";
import type { Attachment } from "@/types";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@greywork/host-ipc", () => ({
  invoke: (command: string, args?: unknown) => h.invoke(command, args),
}));
vi.mock("@/stores/notice", () => ({ notify: vi.fn() }));

import { ragTarget, retrieveContext, sttTarget, transcribeAttachment, type LocalAiConfigLike, type LocalAiDeps } from "@/lib/local-ai";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "p1",
    name: "本地 Ollama",
    kind: "ollama",
    baseUrl: "http://localhost:11434",
    model: "qwen2.5",
    enabled: true,
    ...overrides,
  };
}

function fakeLlm(overrides: Partial<LlmClient> = {}): LlmClient {
  return {
    isAvailable: () => true,
    chat: () => Promise.resolve(1),
    stop: () => Promise.resolve(),
    onEvent: () => Promise.resolve(() => undefined),
    listModels: () => Promise.resolve([]),
    embed: () => Promise.resolve({ embeddings: [[1]], dim: 1, model: "m" }),
    transcribe: () => Promise.resolve({ text: "转写结果" }),
    ...overrides,
  };
}

function deps(config: LocalAiConfigLike | undefined, llm = fakeLlm(), providers: ModelProviderConfig[] = [provider()]): LocalAiDeps {
  return { config, providers, selectedProviderId: null, llm };
}

const RAG_ON: LocalAiConfigLike = { rag: { enabled: true, providerId: null, embeddingModel: "bge-m3", topK: 6 } };
const STT_ON: LocalAiConfigLike = { stt: { enabled: true, providerId: null, model: "whisper-1" } };

function audio(path = "/tmp/a.ogg"): Attachment {
  return { id: "s1", kind: "audio", name: "a.ogg", mime: "audio/ogg", size: 1024, path };
}

beforeEach(() => {
  h.invoke.mockReset();
});

describe("ragTarget / sttTarget", () => {
  it("配置缺字段或供应商不可用时为 null", () => {
    expect(ragTarget(deps(undefined))).toBeNull();
    expect(ragTarget(deps({ rag: { enabled: true } }))).toBeNull(); // 没有 embedding 模型
    expect(ragTarget(deps(RAG_ON, fakeLlm(), []))).toBeNull(); // 没有可用供应商
    expect(sttTarget(deps(STT_ON, fakeLlm(), []))).toBeNull();
  });

  it("跟随当前选中的对话供应商", () => {
    const target = ragTarget({ config: RAG_ON, providers: [provider()], selectedProviderId: "p1", llm: fakeLlm() });
    expect(target?.connection.baseUrl).toBe("http://localhost:11434");
    expect(target?.model).toBe("bge-m3");
    expect(target?.topK).toBe(6);
  });
});

describe("retrieveContext", () => {
  it("未启用 / 空查询 / 无宿主能力：一律 undefined", async () => {
    expect(await retrieveContext(deps(undefined), "问题")).toBeUndefined();
    expect(await retrieveContext(deps(RAG_ON), "   ")).toBeUndefined();
    expect(await retrieveContext(deps(RAG_ON, fakeLlm({ isAvailable: () => false })), "问题")).toBeUndefined();
  });

  it("命中片段：组装成可注入的系统补充并带 topK", async () => {
    h.invoke.mockResolvedValue([
      { path: "src/a.ts", chunkIndex: 2, text: "相关代码", score: 0.9 },
      { path: "src/b.ts", chunkIndex: 0, text: "次相关", score: 0.5 },
    ]);
    const context = await retrieveContext(deps(RAG_ON), "这段逻辑在哪");
    expect(context).toContain("src/a.ts");
    expect(context).toContain("第 3 块");
    expect(context).toContain("相关代码");
    expect(h.invoke).toHaveBeenCalledWith("rag_search", expect.objectContaining({ query: "这段逻辑在哪", topK: 6, model: "bge-m3" }));
  });

  it("零分命中视为无内容（不注入噪声）", async () => {
    h.invoke.mockResolvedValue([{ path: "x", chunkIndex: 0, text: "无关", score: 0 }]);
    expect(await retrieveContext(deps(RAG_ON), "问题")).toBeUndefined();
  });

  it("检索报错：吞掉并返回 undefined（不拦回合）", async () => {
    h.invoke.mockRejectedValue(new Error("服务未启动"));
    expect(await retrieveContext(deps(RAG_ON), "问题")).toBeUndefined();
  });
});

describe("transcribeAttachment", () => {
  it("未启用 / 无路径：null（调用方回落路径引用）", async () => {
    expect(await transcribeAttachment(deps(undefined), audio("/tmp/disabled.ogg"))).toBeNull();
    expect(await transcribeAttachment(deps(STT_ON), audio(""))).toBeNull();
  });

  it("启用：返回转写文本", async () => {
    expect(await transcribeAttachment(deps(STT_ON), audio("/tmp/ok.ogg"))).toBe("转写结果");
  });

  it("转写报错：吞掉并返回 null", async () => {
    const llm = fakeLlm({ transcribe: () => Promise.reject(new Error("whisper 服务未启动")) });
    expect(await transcribeAttachment(deps(STT_ON, llm), audio("/tmp/err.ogg"))).toBeNull();
  });

  it("同一附件（路径+大小）只转写一次（内存缓存）", async () => {
    const llm = fakeLlm();
    const spy = vi.spyOn(llm, "transcribe");
    await transcribeAttachment(deps(STT_ON, llm), audio("/tmp/cache.ogg"));
    await transcribeAttachment(deps(STT_ON, llm), audio("/tmp/cache.ogg"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
