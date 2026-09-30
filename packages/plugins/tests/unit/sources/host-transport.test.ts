// 桌面宿主通道（Tauri IPC）：search 形状归一 + install/uninstall 参数形状。
import { describe, expect, it, vi } from "vitest";
import type * as GreyworkCore from "@greywork/core";
import { invoke } from "@tauri-apps/api/core";
import { HostSkillsTransport, wrapHostSearch } from "../../../src/sources/host-transport";
import { createSkillsShSource, mapSearchResponse, parseSnapshot } from "../../../src/sources/skills-sh";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// invoke 现在经 @greywork/host-ipc 门面分派：建立桌面运行时，断言才落到被 mock 的 Tauri invoke 上。
vi.mock("@greywork/core", async (importOriginal) => ({
  ...(await importOriginal<typeof GreyworkCore>()),
  isTauriRuntime: () => true,
}));

const HOST_ITEMS = [
  { ref: "mattpocock/skills/tdd", skill_id: "tdd", name: "TDD", installs: 10, source: "mattpocock/skills", downloadable: true },
  { ref: "open.feishu.cn/lark-doc", skill_id: "lark-doc", name: "lark-doc", installs: 5, source: "open.feishu.cn", downloadable: false },
];

describe("wrapHostSearch", () => {
  it("normalizes Rust snake_case items into the Web { skills: [...] } shape", () => {
    const wrapped = wrapHostSearch(HOST_ITEMS);
    expect(wrapped.skills).toHaveLength(2);
    const entries = mapSearchResponse(wrapped);
    expect(entries.map((entry) => entry.skillId)).toEqual(["tdd", "lark-doc"]);
    expect(entries[0].ref).toBe("mattpocock/skills/tdd");
    expect(entries[0].downloadable).toBe(true);
    expect(entries[1].downloadable).toBe(false);
  });
});

describe("HostSkillsTransport", () => {
  const transport = new HostSkillsTransport();

  it("is always available and installable", () => {
    expect(transport.available()).toBe(true);
    expect(transport.installable()).toBe(true);
  });

  it("search proxies to skills_search and flows through the source adapter", async () => {
    vi.mocked(invoke).mockResolvedValue(HOST_ITEMS);
    const source = createSkillsShSource(transport, { id: "s", label: "S", description: "" });
    const entries = await source.search("tdd");
    expect(invoke).toHaveBeenCalledWith("skills_search", { query: "tdd" });
    expect(entries.map((entry) => entry.skillId)).toEqual(["tdd", "lark-doc"]);
  });

  it("download proxies to skills_download with the entry ref", async () => {
    vi.mocked(invoke).mockResolvedValue({
      files: [{ path: "SKILL.md", contents: "ok" }],
      hash: "h1",
    });
    const source = createSkillsShSource(transport, { id: "s", label: "S", description: "" });
    const snapshot = await source.download({
      ref: "mattpocock/skills/tdd",
      skillId: "tdd",
      name: "TDD",
      installs: 0,
      source: "mattpocock/skills",
      downloadable: true,
    });
    expect(invoke).toHaveBeenCalledWith("skills_download", { entryRef: "mattpocock/skills/tdd" });
    expect(parseSnapshot(snapshot).hash).toBe("h1");
  });

  it("install/uninstall forward workspaceRoot and skillId to host commands", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await transport.install("/ws", "tdd", [{ path: "SKILL.md", contents: "x" }]);
    expect(invoke).toHaveBeenCalledWith("skills_install", {
      workspaceRoot: "/ws",
      skillId: "tdd",
      files: [{ path: "SKILL.md", contents: "x" }],
    });

    await transport.uninstall("/ws", "tdd");
    expect(invoke).toHaveBeenCalledWith("skills_uninstall", { workspaceRoot: "/ws", skillId: "tdd" });
  });

  it("bundledList/installBundled forward to the bundled host commands", async () => {
    vi.mocked(invoke).mockResolvedValue([{ id: "ffmpeg-media", name: "ffmpeg 媒体处理", description: "转码", files: ["SKILL.md"] }]);
    const list = await transport.bundledList();
    expect(invoke).toHaveBeenCalledWith("skills_bundled_list");
    expect(list.map((skill) => skill.id)).toEqual(["ffmpeg-media"]);

    vi.mocked(invoke).mockResolvedValue({ dir: "/ws/.agents/skills/ffmpeg-media", filesWritten: 1 });
    await transport.installBundled("/ws", "ffmpeg-media");
    expect(invoke).toHaveBeenCalledWith("skills_install_bundled", {
      workspaceRoot: "/ws",
      skillId: "ffmpeg-media",
    });
  });
});
