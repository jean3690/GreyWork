// 源适配层契约：搜索归一化 / 快照解析 / 作用域子源。
import { describe, expect, it } from "vitest";
import { createBuiltinSources, createSkillsShSource, mapSearchResponse, parseSnapshot } from "../../../src/sources/skills-sh";
import type { SkillsMarketTransport } from "../../../src/sources/types";

const SEARCH_RAW = {
  skills: [
    { id: "mattpocock/skills/tdd", skillId: "tdd", name: "tdd", installs: 759925, source: "mattpocock/skills" },
    { id: "open.feishu.cn/lark-doc", skillId: "lark-doc", installs: 614030, source: "open.feishu.cn" },
    { id: "larksuite/cli/lark-doc", skillId: "lark-doc", name: "lark-doc", installs: 424653, source: "larksuite/cli" },
    { id: "broken/entry", installs: 1, source: "x/y" }, // 缺 skillId → 丢弃
  ],
};

describe("mapSearchResponse", () => {
  it("normalizes entries and marks repo sources downloadable", () => {
    const entries = mapSearchResponse(SEARCH_RAW);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ ref: "mattpocock/skills/tdd", downloadable: true, installs: 759925 });
    expect(entries[1]?.downloadable).toBe(false);
  });

  it("scopeSource filters to a single upstream repository", () => {
    const entries = mapSearchResponse(SEARCH_RAW, { scopeSource: "larksuite/cli" });
    expect(entries.map((entry) => entry.source)).toEqual(["larksuite/cli"]);
  });

  it("returns empty on malformed payloads", () => {
    expect(mapSearchResponse(null)).toEqual([]);
    expect(mapSearchResponse({})).toEqual([]);
    expect(mapSearchResponse({ skills: "nope" })).toEqual([]);
  });
});

describe("parseSnapshot", () => {
  it("keeps only well-formed files and tolerates missing hash", () => {
    const snapshot = parseSnapshot({
      files: [{ path: "SKILL.md", contents: "---\nname: x\n---" }, { path: "", contents: "空路径丢弃" }, "garbage"],
    });
    expect(snapshot.files).toEqual([{ path: "SKILL.md", contents: "---\nname: x\n---" }]);
    expect(snapshot.hash).toBe("");
  });

  it("rejects non-object payloads", () => {
    expect(() => parseSnapshot("nope")).toThrow("invalid snapshot payload");
  });
});

describe("createBuiltinSources", () => {
  function fakeTransport(scope: string): SkillsMarketTransport {
    return {
      available: () => true,
      installable: () => true,
      search: async () => SEARCH_RAW,
      download: async (ref) => ({ files: [{ path: "SKILL.md", contents: `of ${ref}` }], hash: scope }),
      install: async () => ({ dir: "/tmp/x", filesWritten: 1 }),
      uninstall: async () => undefined,
    };
  }

  it("exposes aggregate + feishu scoped sources over the same transport", async () => {
    const [aggregate, feishu] = createBuiltinSources(fakeTransport("larksuite/cli"));
    expect(aggregate.id).toBe("skills-sh");
    expect(feishu.id).toBe("feishu-lark");

    const all = await aggregate.search("");
    const larkOnly = await feishu.search("");
    expect(all.length).toBeGreaterThan(larkOnly.length);

    const siteEntry = all.find((entry) => !entry.downloadable);
    await expect(aggregate.download(siteEntry!)).rejects.toThrow("not downloadable");
  });

  it("download maps entry ref through transport snapshot", async () => {
    const source = createSkillsShSource(fakeTransport("h"), {
      id: "s",
      label: "S",
      description: "",
    });
    const snapshot = await source.download({ ref: "a/b/c", skillId: "c", name: "c", installs: 0, source: "a/b", downloadable: true });
    expect(snapshot.files[0]?.contents).toContain("a/b/c");
  });
});
