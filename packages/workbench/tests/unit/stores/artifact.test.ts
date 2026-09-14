/**
 * 交付物投递契约：默认落盘路径必须留在卡片上（diskPath），否则「在文件夹中打开」
 * 无从定位 —— 此前 saveArtifactToDisk 的返回值被直接丢弃。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ saveToDisk: vi.fn<(name: string, data: unknown) => Promise<string | null>>() }));

vi.mock("@/lib/artifact-dir", () => ({
  saveArtifactToDisk: (name: string, data: unknown) => h.saveToDisk(name, data),
  resolveArtifactsDir: () => Promise.resolve(null),
}));

import { useArtifactStore } from "@/stores/artifact";
import { appEvents } from "@/events";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  h.saveToDisk.mockResolvedValue("/home/u/.greyWork/artifacts/report.md");
});

describe("deliverArtifact", () => {
  it("把默认落盘路径记进卡片", async () => {
    const store = useArtifactStore();
    const id = await store.deliverArtifact({
      path: "workspaces/w/report.md",
      meta: "Markdown · 任务产物",
      type: "report",
      source: "assistant-pipeline",
      data: "# 报告",
    });
    expect(h.saveToDisk).toHaveBeenCalledWith("report.md", "# 报告");
    expect(store.byId(id)?.diskPath).toBe("/home/u/.greyWork/artifacts/report.md");
  });

  it("落盘失败（浏览器态 / 写盘异常）时卡片无 diskPath，但仍登记", async () => {
    h.saveToDisk.mockResolvedValue(null);
    const store = useArtifactStore();
    const id = await store.deliverArtifact({
      path: "workspaces/w/a.md",
      meta: "Markdown",
      type: "report",
      source: "assistant-pipeline",
      data: "x",
    });
    expect(store.byId(id)?.diskPath).toBeUndefined();
    expect(store.byId(id)?.name).toBe("a.md");
  });

  it("调用方自行落盘时可直接带入 diskPath（不重复写盘）", async () => {
    const store = useArtifactStore();
    const id = await store.deliverArtifact({
      path: "workspaces/w/b.xlsx",
      meta: "Excel",
      type: "dataset",
      source: "analytics",
      diskPath: "/data/proj/artifacts/b.xlsx",
    });
    expect(h.saveToDisk).not.toHaveBeenCalled();
    expect(store.byId(id)?.diskPath).toBe("/data/proj/artifacts/b.xlsx");
  });

  it("落盘路径随事件广播出去，预览面板据它提供「用系统应用打开」", async () => {
    const store = useArtifactStore();
    const payloads: Array<Record<string, unknown>> = [];
    const dispose = appEvents.on("artifact:created", (payload) => payloads.push(payload));

    await store.deliverArtifact({
      path: "workspaces/w/report.md",
      meta: "Markdown",
      type: "report",
      source: "assistant-pipeline",
      data: "# 报告",
    });
    dispose();

    expect(payloads).toEqual([
      expect.objectContaining({ path: "workspaces/w/report.md", diskPath: "/home/u/.greyWork/artifacts/report.md" }),
    ]);
  });
});
