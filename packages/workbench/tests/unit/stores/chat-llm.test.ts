// 聊天 → LLM 路由的纯函数契约：供应商选择与历史整形（含附件展开窗口）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "@greywork/shell";
import type { Attachment } from "@/types";

const h = vi.hoisted(() => ({
  readAttachmentBase64: vi.fn<(item: Attachment) => Promise<string>>(),
  readAttachmentText: vi.fn<(item: Attachment) => Promise<{ text: string; truncated: boolean }>>(),
}));

vi.mock("@/state/attachment-library", () => ({
  readAttachmentBase64: (item: Attachment) => h.readAttachmentBase64(item),
  readAttachmentText: (item: Attachment) => h.readAttachmentText(item),
}));

import { buildLlmHistory, selectLlmProvider, LLM_SYSTEM_PROMPT } from "@/stores/chat-llm";

function provider(overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return {
    id: "p1",
    name: "测试供应商",
    kind: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-test",
    apiKeyEnv: "TEST_KEY",
    enabled: true,
    ...overrides,
  };
}

function imageAttachment(id: string): Attachment {
  return { id, kind: "image", name: `${id}.png`, mime: "image/png", size: 4, path: `/tmp/${id}.png` };
}

function textAttachment(id: string): Attachment {
  return { id, kind: "text", name: `${id}.md`, mime: "text/markdown", size: 10, path: `/tmp/${id}.md` };
}

beforeEach(() => {
  h.readAttachmentBase64.mockReset();
  h.readAttachmentBase64.mockImplementation(() => Promise.resolve("QUJD"));
  h.readAttachmentText.mockReset();
  h.readAttachmentText.mockImplementation(() => Promise.resolve({ text: "# 内容", truncated: false }));
});

describe("selectLlmProvider", () => {
  it("requires enabled + baseUrl + model", () => {
    expect(selectLlmProvider([provider()])?.id).toBe("p1");
    expect(selectLlmProvider([provider({ enabled: false })])).toBeNull();
    expect(selectLlmProvider([provider({ baseUrl: "  " })])).toBeNull();
    expect(selectLlmProvider([provider({ model: "" })])).toBeNull();
    expect(selectLlmProvider([])).toBeNull();
  });

  it("returns the first qualifying provider", () => {
    const picked = selectLlmProvider([
      provider({ id: "off", enabled: false }),
      provider({ id: "first-ok", baseUrl: "http://localhost:11434/v1" }),
      provider({ id: "second-ok" }),
    ]);
    expect(picked?.id).toBe("first-ok");
  });
});

describe("buildLlmHistory", () => {
  it("keeps only non-empty user/assistant messages and prepends system prompt", async () => {
    const history = await buildLlmHistory([
      { role: "system", content: "不应透传的本地 system" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "" }, // 流式占位
      { role: "tool", content: "杂音" },
      { role: "assistant", content: "答复" },
      { role: "user", content: "继续" },
    ]);
    expect(history[0]).toEqual({ role: "system", content: LLM_SYSTEM_PROMPT });
    expect(history.slice(1)).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "答复" },
      { role: "user", content: "继续" },
    ]);
  });

  it("caps history to the most recent entries", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `m${index}` }));
    const history = await buildLlmHistory(many, 20);
    expect(history).toHaveLength(21); // system + 20
    expect(history[1]?.content).toBe("m10");
    expect(history.at(-1)?.content).toBe("m29");
  });

  it("无附件的 user 消息保持纯文本 content（老端点不吃 parts 数组）", async () => {
    const history = await buildLlmHistory([{ role: "user", content: "在吗" }]);
    expect(history[1]?.content).toBe("在吗");
    expect(h.readAttachmentBase64).not.toHaveBeenCalled();
  });

  it("最近一条 user 消息的图片展开为 image_url part", async () => {
    const history = await buildLlmHistory([{ role: "user", content: "看看这张", attachments: [imageAttachment("a1")] }]);
    expect(history[1]?.content).toEqual([
      { type: "text", text: "看看这张" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("文本附件以内联块追加到正文之后", async () => {
    h.readAttachmentText.mockResolvedValue({ text: "# 内容", truncated: true });
    const history = await buildLlmHistory([{ role: "user", content: "读一下", attachments: [textAttachment("t1")] }]);
    const content = history[1]?.content as { type: string; text: string }[];
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("读一下");
    expect(content[0].text).toContain("[附件：t1.md]");
    expect(content[0].text).toContain("[...内容过长已截断]");
  });

  it("内联数据（浏览器态 dataUrl）直接用，不再读盘", async () => {
    const inline: Attachment = {
      id: "a9",
      kind: "image",
      name: "a9.png",
      mime: "image/png",
      size: 4,
      dataUrl: "data:image/png;base64,SU5MSU5F",
    };
    const history = await buildLlmHistory([{ role: "user", content: "看图", attachments: [inline] }]);
    expect((history[1]?.content as { image_url: { url: string } }[])[1].image_url.url).toBe("data:image/png;base64,SU5MSU5F");
    expect(h.readAttachmentBase64).not.toHaveBeenCalled();
  });

  it("只回放最近 3 条带附件的消息，更旧的附件被丢弃", async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      role: "user",
      content: `第${index}张`,
      attachments: [imageAttachment(`a${index}`)],
    }));
    const history = await buildLlmHistory(messages);
    // 前两条（index 0 / 1）不展开，仍是纯文本
    expect(history[1]?.content).toBe("第0张");
    expect(history[2]?.content).toBe("第1张");
    expect(Array.isArray(history[3]?.content)).toBe(true);
    expect(h.readAttachmentBase64).toHaveBeenCalledTimes(3);
  });

  it("图片总量上限 4 张，额度优先给最新的消息", async () => {
    const messages = Array.from({ length: 3 }, (_, index) => ({
      role: "user",
      content: `批次${index}`,
      attachments: [imageAttachment(`b${index}-1`), imageAttachment(`b${index}-2`)],
    }));
    const history = await buildLlmHistory(messages);
    // 最新的两条各拿到 2 张额度；最旧的一条一张都拿不到（其附件被跳过、正文保留）
    expect(h.readAttachmentBase64).toHaveBeenCalledTimes(4);
    expect(history[1]?.content).toBe("批次0");
    expect(Array.isArray(history[2]?.content)).toBe(true);
    expect(Array.isArray(history[3]?.content)).toBe(true);
  });

  it("附件读失败只跳过该条，正文照常入历史", async () => {
    h.readAttachmentBase64.mockRejectedValue(new Error("文件已被删除"));
    const history = await buildLlmHistory([
      { role: "user", content: "还在吗", attachments: [imageAttachment("a1")] },
      { role: "assistant", content: "在" },
    ]);
    expect(history[1]?.content).toBe("还在吗");
    expect(history[2]?.content).toBe("在");
  });

  it("只发附件不带文字：不补空 text part", async () => {
    const history = await buildLlmHistory([{ role: "user", content: "", attachments: [imageAttachment("a1")] }]);
    expect(history[1]?.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  });

  it("只发附件但附件读失败：整条丢弃，不留空 content 给端点", async () => {
    h.readAttachmentBase64.mockRejectedValue(new Error("文件已被删除"));
    const history = await buildLlmHistory([
      { role: "user", content: "", attachments: [imageAttachment("a1")] },
      { role: "assistant", content: "上一轮答复" },
    ]);
    expect(history).toEqual([
      { role: "system", content: LLM_SYSTEM_PROMPT },
      { role: "assistant", content: "上一轮答复" },
    ]);
  });

  it("无文字无附件的空消息仍被过滤", async () => {
    const history = await buildLlmHistory([
      { role: "user", content: "  " },
      { role: "assistant", content: "" },
    ]);
    expect(history).toHaveLength(1);
  });
});
