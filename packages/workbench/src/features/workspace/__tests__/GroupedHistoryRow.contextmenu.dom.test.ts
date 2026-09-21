/**
 * 会话历史行的右键菜单：动作直接复用行内既有处理器（重命名输入框 / 删除二次确认），
 * 不是另开一套 UI。这里钉住「菜单 → 行内状态」这条线。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const copyText = vi.fn<(text: string) => Promise<void>>();
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import GroupedHistoryRow from "@/features/workspace/GroupedHistoryRow.vue";
import { useSessionStore } from "@/stores/session";
import { i18n } from "@/i18n";

const t = i18n.global.t;

function menuItems(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="context-menu-item"]')].map((el) => new DOMWrapper(el));
}

function menuLabels(): string[] {
  return menuItems().map((entry) => entry.text());
}

let wrapper: VueWrapper | null = null;
let sessionId = "";

/** 区域 root 是组件（渲染成 fragment），wrapper.trigger 会打偏，所以显式取行元素。 */
function row() {
  return wrapper!.get('[data-ctx="history-row"]');
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  copyText.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
  const session = useSessionStore().createSession(null, "整理本周改动");
  sessionId = session.id;
  wrapper = mount(GroupedHistoryRow, {
    props: { session: { id: session.id, title: session.title, updatedAt: session.updatedAt }, active: false },
  });
});

describe("会话历史行右键菜单", () => {
  it("三个条目：重命名 / 复制标题 / 删除（删除是破坏性）", async () => {
    await row().trigger("contextmenu");
    await flushPromises();

    expect(menuLabels()).toEqual([
      t("contextMenu.historyRow.rename"),
      t("contextMenu.historyRow.copyTitle"),
      t("contextMenu.historyRow.delete"),
    ]);
    expect(menuItems()[2].attributes("data-variant")).toBe("destructive");
  });

  it("「重命名」铺出行内输入框并聚焦", async () => {
    await row().trigger("contextmenu");
    await flushPromises();
    await menuItems()[0].trigger("click");
    await flushPromises();

    const input = wrapper!.find('input[aria-label="重命名会话"]');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe("整理本周改动");
  });

  it("「复制标题」写剪贴板", async () => {
    await row().trigger("contextmenu");
    await flushPromises();
    await menuItems()[1].trigger("click");
    await flushPromises();
    expect(copyText).toHaveBeenCalledWith("整理本周改动");
  });

  it("「删除」铺出行内二次确认，确认后从 store 删掉", async () => {
    await row().trigger("contextmenu");
    await flushPromises();
    await menuItems()[2].trigger("click");
    await flushPromises();

    expect(wrapper!.text()).toContain("删除该会话？");
    const confirm = wrapper!.findAll("button").find((button) => button.text() === "删除");
    expect(confirm).toBeTruthy();
    await confirm!.trigger("click");
    await flushPromises();

    expect(useSessionStore().getSession(sessionId)).toBeUndefined();
  });
});
