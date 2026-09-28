/**
 * 设置 · 服务分区的可观察行为。
 *
 * 这一页是云端 Office 预览的**唯一**配置入口：没有它，`settings.officeProviders` 只能靠手改
 * 持久化的 JSON 才能启用（UI 文案与宿主报错却都指向「设置 → 服务」）。所以这里守的是
 * 「用户真能配出来」这条链路：启用开关、编辑配方、新增/删除、恢复预设，以及把宿主的
 * 两条硬边界（可内嵌白名单、凭证变量是否已设置）如实显示出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import ServicesSettingsPane from "@/features/settings/ServicesSettingsPane.vue";
import { useSettingsStore } from "@/stores/settings";

const invokeMock = vi.mocked(invoke);

const mounted: VueWrapper[] = [];

/** 弹窗是 shadcn Dialog，内容 Portal 到 body —— wrapper.find 够不到，得包 body 里的根节点。 */
function dialog(): DOMWrapper<Element> {
  const el = document.body.querySelector('[data-slot="dialog-content"]');
  if (!el) throw new Error("未渲染出 dialog-content");
  return new DOMWrapper(el);
}

function mountPane(): VueWrapper {
  const wrapper = mount(ServicesSettingsPane);
  mounted.push(wrapper);
  return wrapper;
}

function overrideRuntime(mode: "desktop" | "server" | "browser-preview"): void {
  (window as unknown as Record<string, unknown>).__GREYWORK_RUNTIME__ = mode;
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

describe("ServicesSettingsPane 配置链路", () => {
  it("列出四条 office 预设，默认全部未启用、未填配方", () => {
    const wrapper = mountPane();
    for (const id of ["wps365", "tencent-docs", "microsoft365", "custom"]) {
      expect(wrapper.find(`[data-testid="office-provider-${id}"]`).exists()).toBe(true);
    }
    expect(wrapper.text()).toContain("未填配方");
  });

  it("勾选启用开关即落库", async () => {
    const wrapper = mountPane();
    const settings = useSettingsStore();
    await wrapper.get('[data-testid="office-provider-enable-wps365"]').setValue(true);

    expect(settings.officeProviders.find((provider) => provider.id === "wps365")?.enabled).toBe(true);
  });

  it("编辑配方：填 url 与取件指针后落库，该服务商随即具备云端预览资格", async () => {
    const wrapper = mountPane();
    const settings = useSettingsStore();

    await wrapper.get('[data-testid="office-provider-edit-wps365"]').trigger("click");
    await flushPromises();

    await dialog().find('[data-testid="office-provider-url"]').setValue("https://open.wps.cn/upload?name={filename}");
    await dialog().find('[data-testid="office-provider-view-url-pointer"]').setValue("/data/url");
    await dialog().find('[data-testid="office-provider-save"]').trigger("click");
    await flushPromises();

    const stored = settings.officeProviders.find((provider) => provider.id === "wps365");
    expect(stored?.recipe?.url).toBe("https://open.wps.cn/upload?name={filename}");
    expect(stored?.recipe?.viewUrlPointer).toBe("/data/url");
    // 列表上的状态跟着变（用户要能看出这条配好了）。
    expect(wrapper.text()).toContain("配方已填");
  });

  it("配方半填就地报错、不落库（半填会被归一化整条丢掉，必须在这里拦住）", async () => {
    const wrapper = mountPane();
    const settings = useSettingsStore();

    await wrapper.get('[data-testid="office-provider-edit-wps365"]').trigger("click");
    await flushPromises();
    await dialog().find('[data-testid="office-provider-url"]').setValue("https://open.wps.cn/upload");
    await dialog().find('[data-testid="office-provider-save"]').trigger("click");
    await flushPromises();

    expect(dialog().text()).toContain("取件指针");
    expect(settings.officeProviders.find((provider) => provider.id === "wps365")?.recipe).toBeUndefined();
  });

  it("新增服务商：落库并自动选中", async () => {
    const wrapper = mountPane();
    const settings = useSettingsStore();
    const before = settings.officeProviders.length;

    await wrapper.get('[data-testid="office-provider-add"]').trigger("click");
    await flushPromises();
    await dialog().find('[data-testid="office-provider-name"]').setValue("自建文档服务");
    await dialog().find('[data-testid="office-provider-credential-env"]').setValue("DOCS_TOKEN");
    await dialog().find('[data-testid="office-provider-save"]').trigger("click");
    await flushPromises();

    expect(settings.officeProviders).toHaveLength(before + 1);
    const created = settings.officeProviders.find((provider) => provider.name === "自建文档服务");
    expect(created?.id.startsWith("custom-office-")).toBe(true);
    expect(created?.credentialEnv).toBe("DOCS_TOKEN");
    expect(settings.selectedOfficeProviderId).toBe(created?.id);
  });

  it("删除当前服务商：从列表消失并清空选中", async () => {
    const wrapper = mountPane();
    const settings = useSettingsStore();

    await wrapper.get('[data-testid="office-provider-edit-microsoft365"]').trigger("click");
    await flushPromises();
    await dialog().find('[data-testid="office-provider-remove"]').trigger("click");
    await flushPromises();

    expect(settings.officeProviders.some((provider) => provider.id === "microsoft365")).toBe(false);
    expect(wrapper.find('[data-testid="office-provider-microsoft365"]').exists()).toBe(false);
  });

  it("恢复默认：回到四条预设", async () => {
    const wrapper = mountPane();
    const settings = useSettingsStore();
    await wrapper.get('[data-testid="office-provider-enable-custom"]').setValue(true);
    expect(settings.officeProviders.find((provider) => provider.id === "custom")?.enabled).toBe(true);

    await wrapper.get('[data-testid="office-provider-reset"]').trigger("click");
    await flushPromises();

    expect(settings.officeProviders.map((provider) => provider.id)).toEqual(["wps365", "tencent-docs", "microsoft365", "custom"]);
    expect(settings.officeProviders.every((provider) => !provider.enabled)).toBe(true);
  });
});

describe("ServicesSettingsPane 宿主事实", () => {
  it("桌面态：显示宿主可内嵌白名单与未设置的凭证变量名", async () => {
    overrideRuntime("desktop");
    invokeMock.mockResolvedValue({
      embeddableFrameOrigins: ["https://docs.example.com"],
      envPresent: [],
      envMissing: ["WPS365_ACCESS_TOKEN"],
    });
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.get('[data-testid="office-provider-allow-list"]').text()).toContain("https://docs.example.com");
    expect(wrapper.get('[data-testid="office-provider-env-missing"]').text()).toContain("WPS365_ACCESS_TOKEN");
  });

  it("白名单为空时如实说明「宿主未允许任何外部域名」，而不是显示成空白", async () => {
    // 桌面态与服务端态在这一页走的是同一条路径（都 `hasHostCommands()` 为真、都走
    // `office_host_info`）；差异在宿主侧怎么算白名单，由 Rust 侧用例覆盖。
    overrideRuntime("desktop");
    invokeMock.mockResolvedValue({ embeddableFrameOrigins: [], envPresent: [], envMissing: [] });
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.get('[data-testid="office-provider-allow-list"]').text()).toContain("未允许任何外部域名");
  });

  it("浏览器预览态：说明没有宿主，且不发宿主命令", async () => {
    const wrapper = mountPane();
    await flushPromises();

    expect(wrapper.get('[data-testid="office-provider-allow-list"]').text()).toContain("浏览器预览态");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
