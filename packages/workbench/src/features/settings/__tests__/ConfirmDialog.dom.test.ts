// ConfirmDialog 已从手写弹层改为 shadcn-vue AlertDialog 的封装（features/settings/ConfirmDialog.vue）。
// 这里锁住的是「换底层不能换契约」：对外 props/emits/slot 不变，对内拿到 alertdialog 语义。
//
// 两个测试环境注意事项：
//   1. 弹层被 Portal 到 body，断言一律查 document.body，wrapper.find 够不到。
//   2. reka-ui 的 Presence 在挂载后一个 tick 才把内容渲染出来，所以挂载必须 await。
import { afterEach, describe, expect, it } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import ConfirmDialog from "@/features/settings/ConfirmDialog.vue";

const mounted: VueWrapper[] = [];

async function mountDialog(props: Record<string, unknown> = {}, slots?: Record<string, string>): Promise<VueWrapper> {
  const wrapper = mount(ConfirmDialog, {
    props: { title: "删除 MCP 服务器？", message: "此操作不可撤销。", ...props },
    slots,
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 弹层根节点（Portal 后落在 body 下）。 */
function dialogContent(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!el) throw new Error("未渲染出 alert-dialog-content");
  return el;
}

/** 弹层里的按钮，按渲染顺序：[取消, 确认]。 */
function buttons(): HTMLButtonElement[] {
  return [...dialogContent().querySelectorAll<HTMLButtonElement>("button")];
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("ConfirmDialog · 契约", () => {
  it("渲染 title 与 message", async () => {
    await mountDialog({ title: "安装插件？" });

    expect(dialogContent().textContent).toContain("安装插件？");
    expect(dialogContent().textContent).toContain("此操作不可撤销。");
  });

  it("默认插槽渲染在弹层内（安装确认的能力清单走这里）", async () => {
    await mountDialog({ title: "安装插件？" }, { default: '<div data-testid="capability-list">能力列表</div>' });

    expect(dialogContent().querySelector('[data-testid="capability-list"]')).not.toBeNull();
  });

  it("confirmLabel 覆盖确认按钮文案", async () => {
    await mountDialog({ confirmLabel: "删除" });
    expect(buttons()[1].textContent?.trim()).toBe("删除");
  });

  it("未传 confirmLabel 时确认按钮为「确认」", async () => {
    await mountDialog();
    expect(buttons()[1].textContent?.trim()).toBe("确认");
  });
});

describe("ConfirmDialog · 事件", () => {
  it("点确认只发 confirm，不额外冒 cancel", async () => {
    const wrapper = await mountDialog({ confirmLabel: "删除" });

    buttons()[1].click();
    await flushPromises();

    expect(wrapper.emitted("confirm")).toHaveLength(1);
    // 确认按钮故意不走 AlertDialogAction（那个是 DialogClose，关闭早于 click 处理器，
    // 会多冒一个 cancel 把消费者的 target 清两遍）。这条用例就是那道防线。
    expect(wrapper.emitted("cancel")).toBeUndefined();
  });

  it("点取消只发 cancel", async () => {
    const wrapper = await mountDialog();

    buttons()[0].click();
    await flushPromises();

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("confirm")).toBeUndefined();
  });

  it("busy 时确认按钮禁用，不会发出 confirm", async () => {
    const wrapper = await mountDialog({ busy: true });

    expect(buttons()[1].disabled).toBe(true);
    buttons()[1].click();
    await flushPromises();

    expect(wrapper.emitted("confirm")).toBeUndefined();
  });
});

describe("ConfirmDialog · 无障碍", () => {
  it("用 alertdialog 语义并关联标题", async () => {
    await mountDialog({ title: "卸载插件？" });

    const content = dialogContent();
    expect(content.getAttribute("role")).toBe("alertdialog");

    const labelledBy = content.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toContain("卸载插件？");
  });

  it("打开时焦点落在「取消」上，破坏性动作不是默认焦点", async () => {
    await mountDialog({ confirmLabel: "卸载" });
    // 自动聚焦由 reka-ui 在 openAutoFocus 后的 nextTick 里做，再多让一轮。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.activeElement).toBe(buttons()[0]);
  });
});
