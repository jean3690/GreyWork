import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, type CommandContext } from "../src/commands.js";
import { marketOrigin } from "../src/market-sources.js";
import { normalizeSkillsSearch } from "../src/skills-market.js";

const JAVA_SKILL = {
  ref: "greywork/skills/example",
  skill_id: "example",
  name: "Example",
  installs: 0,
  source: "greywork",
  downloadable: true,
};
const JAVA_MCP = { servers: [{ server: { name: "greywork/mcp", remotes: [{ type: "streamable-http", url: "https://mcp.test/mcp" }] } }] };
const fetchMock = vi.fn<typeof fetch>();
let backend: string | null;
const ctx = {
  trustedHost: true,
  controlPlane: { status: () => ({ baseUrl: backend }) },
} as unknown as CommandContext;

beforeEach(() => {
  backend = null;
  vi.stubEnv("GREYWORK_CONTROL_URL", "");
  vi.stubEnv("GREYWORK_SKILLS_ORIGIN", "");
  vi.stubEnv("GREYWORK_MCP_REGISTRY_URL", "");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("默认 Java 目录与第三方来源", () => {
  it("未登录也默认访问本地 Java 后端的公共目录", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([JAVA_SKILL])).mockResolvedValueOnce(Response.json(JAVA_MCP));
    await dispatch("skills_search", { query: "example" }, ctx);
    await dispatch("mcp_search", { search: "greywork" }, ctx);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8080/api/skills?q=example");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8080/api/market/mcp/v0/servers?limit=20&search=greywork");
  });

  it("搜索、下载和 MCP 都跟随当前账号后端，无缓存旧地址", async () => {
    backend = "https://java.test/grey/";
    fetchMock.mockResolvedValueOnce(Response.json([JAVA_SKILL]));
    const result = await dispatch("skills_search", { query: " example " }, ctx);
    expect(result).toEqual({ kind: "json", value: [{ ...JAVA_SKILL, origin: "https://java.test/grey" }] });
    fetchMock.mockResolvedValueOnce(Response.json({ files: [{ path: "SKILL.md", contents: "# example" }], hash: "h" }));
    await dispatch("skills_download", { entryRef: JAVA_SKILL.ref }, ctx);
    expect(fetchMock.mock.calls[1][0]).toBe("https://java.test/grey/api/download/greywork/skills/example");
    backend = "https://other-java.test";
    fetchMock.mockResolvedValueOnce(Response.json(JAVA_MCP));
    expect(await dispatch("mcp_search", {}, ctx)).toMatchObject({ kind: "json", value: [{ name: "greywork/mcp" }] });
    expect(fetchMock.mock.calls[2][0]).toBe("https://other-java.test/api/market/mcp/v0/servers?limit=20");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.headers)).toBe(true);
  });

  it("显式第三方源优先于环境变量和已接入后端", async () => {
    backend = "https://java.test";
    vi.stubEnv("GREYWORK_SKILLS_ORIGIN", "https://skills-env.test/");
    vi.stubEnv("GREYWORK_MCP_REGISTRY_URL", "https://mcp-env.test/");
    expect(marketOrigin("skills", null, backend)).toBe("https://skills-env.test");
    expect(marketOrigin("mcp", null, backend)).toBe("https://mcp-env.test");
    fetchMock.mockResolvedValueOnce(Response.json({ skills: [{ id: "other/repo/example", skillId: "example", name: "Third Party" }] }));
    expect(await dispatch("skills_search", { query: "example", origin: "https://www.skills.sh/" }, ctx)).toMatchObject({
      kind: "json",
      value: [{ ref: "other/repo/example", skill_id: "example", origin: "https://www.skills.sh" }],
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.skills.sh/api/search?q=example");
    fetchMock.mockResolvedValueOnce(Response.json(JAVA_MCP));
    await dispatch("mcp_search", { origin: "https://registry.test/" }, ctx);
    expect(fetchMock.mock.calls[1][0]).toBe("https://registry.test/v0/servers?limit=20");
  });

  it("只配置 Java URL 无 token 时也可浏览，登录配置仍优先", () => {
    vi.stubEnv("GREYWORK_CONTROL_URL", "https://env-java.test/");
    expect(marketOrigin("skills")).toBe("https://env-java.test");
    expect(marketOrigin("mcp")).toBe("https://env-java.test/api/market/mcp");
    expect(marketOrigin("skills", null, "https://linked.test")).toBe("https://linked.test");
  });

  it("自定义技能源兼容两种搜索路径，不把错误静默变成空结果", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ skills: [{ id: "a/b/c", skillId: "c" }] }));
    await dispatch("skills_search", { query: "c", origin: "https://custom.test" }, ctx);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://custom.test/api/skills?q=c", "https://custom.test/api/search?q=c"]);
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(dispatch("mcp_search", {}, ctx)).rejects.toThrow("503");
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(dispatch("skills_search", { query: "c" }, ctx)).rejects.toThrow("503");
  });

  it("条目明确不可下载时保留标志，拒绝路径穿越且不发请求", async () => {
    expect(normalizeSkillsSearch([{ ...JAVA_SKILL, downloadable: false }], "https://java.test")[0].downloadable).toBe(false);
    await expect(dispatch("skills_download", { entryRef: "a/b/.." }, ctx)).rejects.toThrow("invalid entry ref");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
