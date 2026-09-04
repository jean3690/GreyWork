// Web 预览环境市场通道：经本地 Vite 代理（同源）绕开 CORS。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinSources, createSkillsShSource } from "../../../src/sources/skills-sh";
import { createSkillsTransport, MARKET_API_BASE, WebSkillsTransport } from "../../../src/sources/web-transport";

const SEARCH_RAW = {
  skills: [
    { id: "larksuite/cli/lark-doc", skillId: "lark-doc", name: "lark-doc", installs: 100, source: "larksuite/cli" },
    { id: "github/awesome-copilot/git-commit", skillId: "git-commit", name: "git-commit", installs: 42, source: "github/awesome-copilot" },
  ],
};

function installFetch(mock: (url: string) => Promise<unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((input: string) => {
      void input;
      return mock(input).then((body) => ({ ok: true, json: () => Promise.resolve(body) }));
    }),
  );
}

describe("WebSkillsTransport", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = globalThis;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).window;
  });

  it("proxies search and download through MARKET_API_BASE", async () => {
    const seen: string[] = [];
    installFetch(async (url) => {
      seen.push(url);
      return url.includes("/api/search") ? SEARCH_RAW : { files: [{ path: "SKILL.md", contents: "ok" }], hash: "h" };
    });
    const transport = new WebSkillsTransport();
    const source = createSkillsShSource(transport, { id: "s", label: "S", description: "" });

    const entries = await source.search("lark");
    expect(entries.map((entry) => entry.skillId)).toEqual(["lark-doc", "git-commit"]);
    expect(seen[0]).toBe(`${MARKET_API_BASE}/skills/api/search?q=lark`);

    const snapshot = await source.download(entries[0]);
    expect(snapshot.hash).toBe("h");
    expect(seen[1]).toBe(`${MARKET_API_BASE}/skills/api/download/larksuite/cli/lark-doc`);
  });

  it("URL-encodes query and ref segments", async () => {
    const seen: string[] = [];
    installFetch(async (url) => {
      seen.push(url);
      return url.includes("/api/search") ? SEARCH_RAW : { files: [], hash: "" };
    });
    const transport = new WebSkillsTransport();
    await transport.search("tdd 测试");
    expect(seen[0]).toBe(`${MARKET_API_BASE}/skills/api/search?q=tdd%20%E6%B5%8B%E8%AF%95`);
    await expect(transport.download("bad/ref")).rejects.toThrow(/not a downloadable/i);
  });

  it("rejects install/uninstall with a desktop-only error", async () => {
    const transport = new WebSkillsTransport();
    await expect(transport.install("/tmp", "x", [])).rejects.toThrow(/desktop host/i);
    await expect(transport.uninstall("/tmp", "x")).rejects.toThrow(/desktop host/i);
    expect(transport.installable()).toBe(false);
  });

  it("factory picks the web transport outside Tauri and scoped sources map via proxy", async () => {
    installFetch(async () => SEARCH_RAW);
    const transport = createSkillsTransport();
    expect(transport).toBeInstanceOf(WebSkillsTransport);
    const [aggregate, feishu] = createBuiltinSources(transport);
    expect((await aggregate.search("")).length).toBe(2);
    expect((await feishu.search("")).map((entry) => entry.skillId)).toEqual(["lark-doc"]);
  });

  it("surfaces non-OK fetch as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const transport = new WebSkillsTransport();
    await expect(transport.search("x")).rejects.toThrow(/502/);
  });
});
