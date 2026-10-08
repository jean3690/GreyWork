/**
 * 团队页附件链路（面板侧）：起跑表单粘贴附件 → 托盘 chip → 起跑时作为第三参传给 startRun。
 *
 * 只测「面板把附件交出去」这一段接线；附件如何进 prompt units 由 stores/cowork.test.ts 覆盖。
 * 附件采集模块整体 mock 掉：真实现要读盘 / 拉系统选择框，happy-dom 里走不通。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { Attachment } from "@/types";

vi.mock("@/state/attachment-library", () => ({
  pickAttachments: () => Promise.resolve([] as Attachment[]),
  attachmentsFromFiles: (files: readonly File[]) =>
    Promise.resolve(files.map((file, index) => ({ id: `att-${index}`, kind: "file", name: file.name, mime: "text/plain", size: 1 }))),
  attachmentsFromPaths: () => Promise.resolve([] as Attachment[]),
  attachmentsFromClipboard: () => Promise.resolve([] as Attachment[]),
  materializeAttachments: (_sessionId: string, items: readonly Attachment[]) => Promise.resolve([...items]),
  readAttachmentBase64: () => Promise.resolve(""),
  readAttachmentText: () => Promise.resolve({ text: "", truncated: false }),
  attachmentObjectUrl: () => Promise.resolve(null),
  releaseAttachmentObjectUrls: () => undefined,
}));

import CoworkPanel from "@/features/team/CoworkPanel.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";
import { useCoworkStore } from "@/stores/cowork";

const t = i18n.global.t;

async function mountPanel(): Promise<ReturnType<typeof mount>> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  await router.push("/team");
  await router.isReady();
  return mount(CoworkPanel, { global: { plugins: [pinia, i18n, router] } });
}

beforeEach(() => {
  localStorage.clear();
});

describe("CoworkPanel · 附件", () => {
  it("起跑表单渲染附件入口", async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="cowork-goal-attach"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(t("cowork.attachHint"));
  });

  it("起跑表单粘贴附件：出 chip，起跑时作为第三参传给 startRun", async () => {
    const wrapper = await mountPanel();
    const startRun = vi.spyOn(useCoworkStore(), "startRun").mockResolvedValue(null);
    const file = new File(["x"], "spec.md", { type: "text/plain" });

    await wrapper.get(`textarea[placeholder="${t("cowork.goalPlaceholder")}"]`).trigger("paste", { clipboardData: { files: [file] } });
    await flushPromises();
    expect(wrapper.findAll('[data-testid="attachment-chip"]')).toHaveLength(1);

    const start = wrapper.findAll("button").find((button) => button.text().includes(t("cowork.start")));
    await start!.trigger("click");
    await flushPromises();

    expect(startRun).toHaveBeenCalledTimes(1);
    const [, , attachments] = startRun.mock.calls[0] as [string, unknown, Attachment[]];
    expect(attachments.map((item) => item.name)).toEqual(["spec.md"]);
  });
});
