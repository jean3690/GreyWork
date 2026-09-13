// 权限三档下拉契约：Read Only / Workspace 直接生效并持久化；
// Full Access 必须先过警告对话框（取消不生效，确认后生效）；
// 面板方向随净空翻转（贴底向上弹，对齐模型选择器）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AgentScopeSelect from "@/components/AgentScopeSelect.vue";
import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";

beforeEach(() => {
  // 清掉上一用例 persist 的设置快照，避免档位串扰
  window.localStorage.removeItem("greywork.settings");
});

function mountScope() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(AgentScopeSelect, { global: { plugins: [pinia, i18n] } });
  const settings = useSettingsStore();
  return { wrapper, settings };
}

function trigger(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.find("button[aria-haspopup]");
  expect(button.exists()).toBe(true);
  return button;
}

function dialogButton(wrapper: ReturnType<typeof mount>, label: string) {
  const option = wrapper.findAll('[role="dialog"] button').find((button) => button.text().includes(label));
  expect(option, `对话框按钮 ${label}`).toBeDefined();
  return option!;
}

function menuOption(wrapper: ReturnType<typeof mount>, label: string) {
  const option = wrapper.findAll('button[role="menuitemradio"]').find((button) => button.text().includes(label));
  expect(option, `菜单项 ${label}`).toBeDefined();
  return option!;
}

describe("AgentScopeSelect · 权限三档", () => {
  it("默认工作区档；菜单点选只读立即生效（无对话框）", async () => {
    const { wrapper, settings } = mountScope();
    expect(settings.permissionTier).toBe("workspace");
    expect(wrapper.text()).toContain("工作区");

    await trigger(wrapper).trigger("click");
    await menuOption(wrapper, "只读").trigger("click");
    expect(settings.permissionTier).toBe("read-only");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("选择完全访问先弹警告：取消不生效，确认后生效", async () => {
    const { wrapper, settings } = mountScope();
    await trigger(wrapper).trigger("click");
    await menuOption(wrapper, "完全访问").trigger("click");

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("开启完全访问");
    expect(settings.permissionTier).toBe("workspace"); // 未确认前保持原档

    // 取消：档位不变
    await dialogButton(wrapper, "取消").trigger("click");
    expect(settings.permissionTier).toBe("workspace");

    // 重选并确认
    await trigger(wrapper).trigger("click");
    await menuOption(wrapper, "完全访问").trigger("click");
    await dialogButton(wrapper, "仍要开启").trigger("click");
    expect(settings.permissionTier).toBe("full");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it("已在完全访问档时重选不再弹窗", async () => {
    const { wrapper, settings } = mountScope();
    settings.permissionTier = "full";
    await trigger(wrapper).trigger("click");
    await menuOption(wrapper, "完全访问").trigger("click");
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(settings.permissionTier).toBe("full");
  });
});

describe("AgentScopeSelect · 面板方向", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** happy-dom 视口 768 高；胶囊 24 高，贴底 = 输入卡底栏场景。 */
  function stubRect(top: number): void {
    const rect = { left: 300, top, right: 400, bottom: top + 24, width: 100, height: 24, x: 300, y: top, toJSON: () => ({}) };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
  }

  it("触发器贴近视口底部 → 面板向上弹（bottom-full），选项仍可点选", async () => {
    stubRect(706);
    const { wrapper, settings } = mountScope();
    await trigger(wrapper).trigger("click");

    const panel = wrapper.find('div.bottom-full[class*="absolute"]');
    expect(panel.exists()).toBe(true);
    expect(panel.classes()).not.toContain("top-full");
    await menuOption(wrapper, "只读").trigger("click");
    expect(settings.permissionTier).toBe("read-only");
  });

  it("下方净空充足 → 保持向下（top-full）", async () => {
    stubRect(120);
    const { wrapper } = mountScope();
    await trigger(wrapper).trigger("click");

    const panel = wrapper.find('div.top-full[class*="absolute"]');
    expect(panel.exists()).toBe(true);
    expect(panel.classes()).not.toContain("bottom-full");
  });

  it("右对齐会越过主区左边界时改为向右展开，避免被侧栏裁掉", async () => {
    const main = document.createElement("main");
    document.body.appendChild(main);
    const rect = (left: number, right: number, top = 400, bottom = 424): DOMRect =>
      ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "MAIN" ? rect(248, 1000, 42, 820) : rect(260, 340);
    });
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(AgentScopeSelect, { attachTo: main, global: { plugins: [pinia, i18n] } });

    await trigger(wrapper).trigger("click");
    const panel = wrapper.get('[role="menu"]');
    expect(panel.classes()).toContain("left-0");
    expect(panel.classes()).not.toContain("right-0");

    wrapper.unmount();
    main.remove();
  });
});
