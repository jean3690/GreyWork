// 设置弹窗契约：左栏切换分区、右上角关闭与 Esc 退场；内容面板由 SettingsView 按 section 渲染。
//
// 弹层已改为 shadcn Dialog：内容 Portal 到 body，wrapper.find 够不到，
// 所以用 DOMWrapper 包住弹层根节点做选择器；emitted 仍从 mount 出的 wrapper 上取。
// 挂载必须 await：reka 的 Presence 在挂载后一个 tick 才渲染内容。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsDialog from "@/features/settings/SettingsDialog.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";

const mounted: VueWrapper[] = [];

async function mountDialog(section: string, props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter();
  const wrapper = mount(SettingsDialog, {
    props: { open: true, section, ...props },
    global: { plugins: [pinia, i18n, router] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 弹层根节点（Portal 后落在 body 下）。 */
function dialog(): DOMWrapper<Element> {
  const element = document.body.querySelector('[data-testid="settings-dialog"]');
  if (!element) throw new Error("未渲染出 settings-dialog");
  return new DOMWrapper(element);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SettingsDialog", () => {
  it("按 section 渲染对应面板，并在左栏高亮当前分区", async () => {
    await mountDialog("appearance");
    expect(dialog().text()).toContain("外观");
    expect(dialog().find('[data-testid="settings-nav-appearance"]').attributes("aria-current")).toBe("page");
    expect(dialog().find('[data-testid="settings-nav-agent"]').attributes("aria-current")).toBeUndefined();
  });

  it("点左栏条目只向上报新的分区（开关留在 Shell）", async () => {
    const wrapper = await mountDialog("agent");
    await dialog().find('[data-testid="settings-nav-team"]').trigger("click");
    expect(wrapper.emitted("update:section")).toEqual([["team"]]);
  });

  it("关闭入口与 Esc 都只发关闭诉求，不自作主张改路由", async () => {
    const wrapper = await mountDialog("agent");

    await dialog().find('[data-testid="settings-close"]').trigger("click");
    expect(wrapper.emitted("update:open")).toEqual([[false]]);

    // reka 的 DismissableLayer 用 onKeyStroke 监听 window 上的 Escape，
    // 所以这里派发到 window 即可命中（不再有自挂的 window 监听）。
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(wrapper.emitted("update:open")).toHaveLength(2);
  });

  it("open 为 false 时不渲染", async () => {
    setActivePinia(createPinia());
    const wrapper = await mountDialog("agent", { open: false });
    expect(document.body.querySelector('[data-testid="settings-dialog"]')).toBeNull();
    expect(wrapper.emitted("update:open")).toBeUndefined();
  });
});
