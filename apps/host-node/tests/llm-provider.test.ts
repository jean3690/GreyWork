import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatBody, endpointUrl, probeAgentModel } from "../src/llm.js";
import { readChatResponse } from "../src/llm-response.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("第三方模型请求", () => {
  it.each([
    ["https://api.example.com", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/v1/", "https://api.example.com/v1/chat/completions"],
    ["https://api.example.com/openai", "https://api.example.com/openai/chat/completions"],
    ["https://api.example.com/compatible-mode/v1", "https://api.example.com/compatible-mode/v1/chat/completions"],
    ["https://api.example.com/api/v1/chat/completions", "https://api.example.com/api/v1/chat/completions"],
    ["https://api.example.com/openai?api-version=2026", "https://api.example.com/openai/chat/completions?api-version=2026"],
  ])("保留网关路径 %s", (base, expected) => {
    expect(endpointUrl(base, "chat/completions")).toBe(expected);
  });

  it("拒绝非 HTTP 地址和 URL 内的凭证", () => {
    for (const url of ["file:///etc/passwd", "https://key:secret@example.com", "not a url"])
      expect(() => endpointUrl(url, "models")).toThrow();
  });

  it("合并供应商扩展参数，支持新 token 字段和移除不兼容参数", () => {
    expect(
      buildChatBody(
        {
          model: "custom",
          maxTokens: 32,
          temperature: 0.2,
          stream: false,
          extraBody: { max_completion_tokens: 8192, temperature: null, chat_template_kwargs: { enable_thinking: false } },
        },
        [],
      ),
    ).toEqual({
      model: "custom",
      messages: [],
      stream: false,
      max_completion_tokens: 8192,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("扩展参数不能覆盖 agent 控制字段", () => {
    for (const key of ["model", "messages", "tools", "tool_choice", "stream", "n", "functions"])
      expect(() => buildChatBody({ model: "m", extraBody: { [key]: null } }, [])).toThrow(key);
  });

  it("工具测试完成请求→合成工具结果→最终回答，不执行真实工具", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.tool_choice !== "none")
        return Response.json({
          choices: [
            { message: { tool_calls: [{ id: "probe1", function: { name: "greywork_probe", arguments: '{"value":"greywork"}' } }] } },
          ],
        });
      expect(body.messages.at(-1).tool_call_id).toBe("probe1");
      return Response.json({ choices: [{ message: { content: body.messages.at(-1).content } }] });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      probeAgentModel({ baseUrl: "https://gateway.example/openai", model: "third-party", stream: false, extraBody: { top_p: 0.8 } }),
    ).resolves.toEqual({ ok: true, model: "third-party" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toMatchObject({ stream: false, top_p: 0.8 });
  });

  it("HTTP 200 但不调用工具也不能冒充测试成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ choices: [{ message: { content: "hello" } }] })),
    );
    await expect(probeAgentModel({ baseUrl: "https://gateway.example", model: "m" })).rejects.toThrow("未返回测试工具调用");
  });
});

describe("模型响应消费", () => {
  const signal = () => new AbortController().signal;
  const sse = (frames: unknown[], tail = "\ndata: [DONE]\n") =>
    new Response(frames.map((frame) => "data: " + JSON.stringify(frame)).join("\r\n") + tail, {
      headers: { "content-type": "text/event-stream" },
    });
  it("同一批网络字节中的思考先于正文发出", async () => {
    const order: string[] = [];
    await readChatResponse(
      sse([
        { choices: [{ delta: { reasoning_content: "think" } }] },
        { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
      ]),
      signal(),
      {
        onText: () => order.push("text"),
        onThinking: () => order.push("thinking"),
      },
    );
    expect(order).toEqual(["thinking", "text"]);
  });

  it("按 index 拼接交错工具名/参数，保留推理字段和没有换行的尾帧", async () => {
    const response = sse(
      [
        {
          choices: [
            {
              delta: {
                reasoning_content: "先读取",
                tool_calls: [
                  { index: 1, id: "b", function: { name: "list_", arguments: "{" } },
                  { index: 0, id: "a", function: { name: "read_", arguments: '{"path":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "file", arguments: '"a.txt"}' } },
                  { index: 1, function: { name: "dir", arguments: "}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      "",
    );
    const thinking = vi.fn();
    const out = await readChatResponse(response, signal(), { onThinking: thinking });
    expect(out.calls).toEqual([
      { id: "a", name: "read_file", arguments: '{"path":"a.txt"}' },
      { id: "b", name: "list_dir", arguments: "{}" },
    ]);
    expect(out.reasoning).toBe("先读取");
    expect(thinking).toHaveBeenCalledWith("先读取");
  });

  it("输出截断和流提前关闭不能执行工具", async () => {
    const frame = {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: "write_file", arguments: '{"path":"a"}' } }] }, finish_reason: "length" },
      ],
    };
    await expect(readChatResponse(sse([frame]), signal())).rejects.toThrow("token 上限");
    await expect(readChatResponse(sse([{ choices: [{ delta: { content: "半截" } }] }], ""), signal())).rejects.toThrow("提前结束");
  });

  it("HTTP 200 的错误 JSON 不应静默变成空回答", async () => {
    await expect(readChatResponse(Response.json({ error: { message: "bad key" } }), signal())).rejects.toThrow("bad key");
    await expect(readChatResponse(Response.json({ content: "wrong protocol" }), signal())).rejects.toThrow("Chat Completions");
  });

  it("空闲超时是可见错误，不冒充用户取消", async () => {
    const response = new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    await expect(readChatResponse(response, signal(), { idleTimeoutMs: 10 })).rejects.toThrow("idle timeout");
  });
});
