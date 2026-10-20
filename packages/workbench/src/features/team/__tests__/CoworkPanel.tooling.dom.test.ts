/**
 * 起跑表单 → startRun 的 run 级工具面接线：
 * 本轮能力卡里勾选的 MCP / 技能被翻译成 `CoworkRunOptions`（第 4 参）。
 *
 * 真实起跑要拉 ACP 进程，这里 spy startRun 只验证「交出去什么」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/state/attachment-library", () => ({
  pickAttachments: () => Promise.resolve([]),
  attachmentsFromFiles: () => Promise.resolve([]),
  attachmentsFromPaths: () => Promise.resolve([]),
  attachmentsFromClipboard: () => Promise.resolve([]),
  materializeAttachments: (_sessionId: string, items: readonly unknown[]) => Promise.resolve([...items]),
  readAttachmentBase64: () => Promise.resolve(""),
  readAttachmentText: () => Promise.resolve({ text: "", truncated: false }),
  attachmentObjectUrl: () => Promise.resolve(null),
  releaseAttachmentObjectUrls: () => undefined,
}));

vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasHostCommands: () => true,
}));

vi.mock("@/stores/skills", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanSkills: vi.fn(async () => [
    { id: "alpha", name: "Alpha", dir: "/ws/.agents/skills/alpha" },
    { id: "beta", name: "Beta", dir: "/ws/.agents/skills/beta" },
  ]),
}));

import CoworkPanel from "@/features/team/CoworkPanel.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useCoworkStore } from "@/stores/cowork";
import { useSettingsStore } from "@/stores/settings";

const t = i18n.global.t;

let pinia: ReturnType<typeof createPinia>;

async function mountPanel(): Promise<ReturnType<typeof mount>> {
  const router = createAppRouter();
  await router.push("/team");
  await router.isReady();
  const wrapper = mount(CoworkPanel, { global: { plugins: [pinia, i18n, router] } });
  // 等 onMounted 里的技能扫描落定
  await flushPromises();
  return wrapper;
}

function startButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll("button").find((candidate) => candidate.text().includes(t("cowork.start")));
  if (!button) throw new Error("start button not found");
  return button;
}

beforeEach(() => {
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});

describe("CoworkPanel · 本轮能力", () => {
  it("默认勾选：未启用的 MCP 不选、技能全选；起跑时翻译成 run 选项", async () => {
    useSettingsStore().workspaceDir = "/ws";
    const wrapper = await mountPanel();

    // 技能默认全选
    expect(wrapper.get('[data-testid="tooling-skill-alpha"]').attributes("aria-pressed")).toBe("true");
    expect(wrapper.get('[data-testid="tooling-skill-beta"]').attributes("aria-pressed")).toBe("true");
    // deepwiki 默认停用 → 未勾选
    expect(wrapper.get('[data-testid="tooling-mcp-deepwiki"]').attributes("aria-pressed")).toBe("false");

    const startRun = vi.spyOn(useCoworkStore(), "startRun").mockResolvedValue(null);
    // 勾上一个 MCP、取消一个技能
    await wrapper.get('[data-testid="tooling-mcp-deepwiki"]').trigger("click");
    await wrapper.get('[data-testid="tooling-skill-beta"]').trigger("click");
    await startButton(wrapper).trigger("click");
    await flushPromises();

    expect(startRun).toHaveBeenCalledTimes(1);
    const options = startRun.mock.calls[0]![3] as { mcpServers: unknown[]; skills: string[] };
    expect(options.skills).toEqual(["alpha"]);
    expect(options.mcpServers).toEqual([{ name: "deepwiki", transport: "http", url: "https://mcp.deepwiki.com/mcp" }]);
  });
});
