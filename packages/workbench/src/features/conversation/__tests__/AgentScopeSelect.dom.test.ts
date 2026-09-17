// 权限三档下拉契约：Read Only / Workspace 直接生效并持久化；
// Full Access 必须先过警告对话框（取消不生效，确认后生效）。
//
// 档位菜单已改为 shadcn DropdownMenu（含 RadioGroup）：内容 Portal 到 body，
// 所以菜单断言走 document.body。「面板方向」那组用例原先是测 lib/panel-placement 的
// 上下翻转 —— 那份实现已删，定位交给 reka 的碰撞处理（side="top" + 自动翻转），
// 由下面「方向交给 reka」与键盘漫游两条用例接手覆盖。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AgentScopeSelect from "@/features/conversation/AgentScopeSelect.vue";
import { i18n } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";

beforeEach(() => {
  // 清掉上一用例 persist 的设置快照，避免档位串扰
  window.localStorage.removeItem("greywork.settings");
});

afterEach(() => {
  // 只清 Portal 出来的弹层节点，不动 VTU 的 attachTo 容器。
  document.body.innerHTML = "";
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

/** 档位项（Portal 后落在 body 下，reka 的 RadioItem 自带 role=menuitemradio）。 */
function menuItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[role="menuitemradio"]')].map((element) => new DOMWrapper(element));
}

function menuOption(label: string): DOMWrapper<Element> {
  const option = menuItems().find((item) => item.text().includes(label));
  expect(option, `菜单项 ${label}`).toBeDefined();
  return option!;
}

/** 警告框根节点；未打开时为 null。 */
function confirmDialog(): DOMWrapper<Element> | null {
  const element = document.body.querySelector('[data-slot="alert-dialog-content"]');
  return element ? new DOMWrapper(element) : null;
}

function dialogButton(label: string): DOMWrapper<Element> {
  const dialog = confirmDialog();
  expect(dialog, "确认框已打开").not.toBeNull();
  const option = dialog!.findAll("button").find((button) => button.text().includes(label));
  expect(option, `对话框按钮 ${label}`).toBeDefined();
  return option!;
}

async function openMenu(wrapper: ReturnType<typeof mount>): Promise<void> {
  await trigger(wrapper).trigger("click");
  await flushPromises();
}

describe("AgentScopeSelect · 权限三档", () => {
  it("默认工作区档；菜单点选只读立即生效（无对话框）", async () => {
    const { wrapper, settings } = mountScope();
    expect(settings.permissionTier).toBe("workspace");
    expect(wrapper.text()).toContain("工作区");

    await openMenu(wrapper);
    await menuOption("只读").trigger("click");
    await flushPromises();
    expect(settings.permissionTier).toBe("read-only");
    expect(confirmDialog()).toBeNull();
  });

  it("菜单把当前档标为选中（aria-checked 由 RadioGroup 接管）", async () => {
    const { wrapper, settings } = mountScope();
    settings.permissionTier = "read-only";
    await flushPromises();

    await openMenu(wrapper);
    const checked = menuItems().filter((item) => item.attributes("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0].text()).toContain("只读");
  });

  it("方向键在档位间漫游（原先手写的 keydown 已交给 reka）", async () => {
    const { wrapper } = mountScope();
    await openMenu(wrapper);

    const first = menuItems()[0].element as HTMLElement;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await flushPromises();

    const focusables = menuItems().map((item) => item.element);
    expect(focusables).toContain(document.activeElement);
    expect(document.activeElement).not.toBe(first);
  });

  it("选择完全访问先弹警告：取消不生效，确认后生效", async () => {
    const { wrapper, settings } = mountScope();
    await openMenu(wrapper);
    await menuOption("完全访问").trigger("click");
    await flushPromises();

    expect(confirmDialog(), "确认框已打开").not.toBeNull();
    expect(confirmDialog()!.text()).toContain("开启完全访问");
    expect(settings.permissionTier).toBe("workspace"); // 未确认前保持原档

    // 取消：档位不变
    await dialogButton("取消").trigger("click");
    await flushPromises();
    expect(settings.permissionTier).toBe("workspace");

    // 重选并确认
    await openMenu(wrapper);
    await menuOption("完全访问").trigger("click");
    await flushPromises();
    await dialogButton("仍要开启").trigger("click");
    await flushPromises();
    expect(settings.permissionTier).toBe("full");
    expect(confirmDialog()).toBeNull();
  });

  it("已在完全访问档时重选不再弹窗", async () => {
    const { wrapper, settings } = mountScope();
    settings.permissionTier = "full";
    await openMenu(wrapper);
    await menuOption("完全访问").trigger("click");
    await flushPromises();
    expect(confirmDialog()).toBeNull();
    expect(settings.permissionTier).toBe("full");
  });

  it("Esc 关闭警告框且档位不变", async () => {
    const { wrapper, settings } = mountScope();
    await openMenu(wrapper);
    await menuOption("完全访问").trigger("click");
    await flushPromises();

    const content = confirmDialog();
    expect(content).not.toBeNull();
    content!.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();

    expect(settings.permissionTier).toBe("workspace");
  });

  it("点菜单外收起菜单（不再依赖自挂的窗口监听）", async () => {
    const { wrapper } = mountScope();
    await openMenu(wrapper);
    expect(menuItems().length).toBeGreaterThan(0);

    const EventCtor = (typeof PointerEvent !== "undefined" ? PointerEvent : Event) as typeof Event;
    document.body.dispatchEvent(new EventCtor("pointerdown", { bubbles: true }));
    await flushPromises();

    expect(menuItems()).toHaveLength(0);
  });
});
