/**
 * 设置 · 本地 AI 分区的可观察行为。
 *
 * 这一页是本地检索（RAG）与语音转写（STT）的**唯一**配置入口：没有它，`settings.localAi`
 * 只能靠手改持久化 JSON 才能启用（错误提示却都指向这一页）。所以这里守的是「用户真能配出来」
 * 这条链路：开关落库、模型/片段数落库、供应商选择落库，以及桌面态能读索引状态并触发构建。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import LocalAiSettingsPane from "@/features/settings/LocalAiSettingsPane.vue";
import { useSettingsStore } from "@/stores/settings";

const invokeMock = vi.mocked(invoke);
const mounted: VueWrapper[] = [];

/** 宿主命令桩：`rag_status` 回状态，其余（store_default_root）回一个工作区路径。 */
function stubHost(): void {
  invokeMock.mockImplementation((command: string) => {
    if (command === "rag_status") return Promise.resolve({ chunks: 3, files: 2, model: "bge-m3", dim: 768 });
    return Promise.resolve("/home/u/.greyWork");
  });
}

function overrideRuntime(mode: "desktop" | "server" | "browser-preview"): void {
  (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = mode;
}

async function mountPane(): Promise<VueWrapper> {
  const wrapper = mount(LocalAiSettingsPane);
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  invokeMock.mockReset();
  invokeMock.mockRejectedValue(new Error("本用例未提供宿主事实"));
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__;
});

describe("LocalAiSettingsPane 配置链路", () => {
  it("默认全关，勾选启用即落库", async () => {
    overrideRuntime("browser-preview");
    const wrapper = await mountPane();
    const settings = useSettingsStore();
    expect(settings.localAi.rag.enabled).toBe(false);

    await wrapper.get('[data-testid="rag-enabled"]').setValue(true);
    await wrapper.get('[data-testid="stt-enabled"]').setValue(true);
    expect(settings.localAi.rag.enabled).toBe(true);
    expect(settings.localAi.stt.enabled).toBe(true);
  });

  it("embedding 模型 / 片段数 / 供应商选择落库", async () => {
    overrideRuntime("browser-preview");
    const wrapper = await mountPane();
    const settings = useSettingsStore();
    const providerId = settings.modelProviders[0].id;

    await wrapper.get('[data-testid="rag-model"]').setValue("nomic-embed-text");
    await wrapper.get('[data-testid="rag-topk"]').setValue("12");
    await wrapper.get('[data-testid="rag-provider"]').setValue(providerId);

    expect(settings.localAi.rag.embeddingModel).toBe("nomic-embed-text");
    expect(settings.localAi.rag.topK).toBe(12);
    expect(settings.localAi.rag.providerId).toBe(providerId);
  });

  it("桌面态：读索引状态、显示工作区根，构建按钮可点", async () => {
    overrideRuntime("desktop");
    stubHost();
    const wrapper = await mountPane();

    expect(invokeMock.mock.calls.some(([command]) => command === "rag_status")).toBe(true);
    expect(wrapper.get('[data-testid="rag-status"]').text()).toContain("2 个文件");
    expect(wrapper.get('[data-testid="rag-status"]').text()).toContain("3 个片段");
    expect((wrapper.get('[data-testid="rag-build"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it("浏览器预览态：说明没有宿主、按钮禁用，且不发宿主命令", async () => {
    overrideRuntime("browser-preview");
    const wrapper = await mountPane();

    expect(wrapper.text()).toContain("浏览器预览态");
    expect(invokeMock).not.toHaveBeenCalled();
    expect((wrapper.get('[data-testid="rag-build"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});
