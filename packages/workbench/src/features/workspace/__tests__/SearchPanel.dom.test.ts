/**
 * 标题栏搜索面板契约：会话（标题 + 正文）与功能入口一起搜，能做类型 / 状态 / 工作区筛选，
 * 键盘 ↑↓/Enter 可选中打开；设置命中走 settings:open 事件（模态非路由）。
 *
 * 面板已改为 shadcn Popover 的 Content（`<Popover>` 由 Titlebar 持有）：
 *   - 挂载必须包一层 `<Popover>`，否则拿不到 PopoverRoot 上下文（reka 会抛）；
 *   - 内容 Portal 到 body，查询一律走 `panel()`（DOMWrapper），wrapper.find 够不到；
 *   - Esc / 点外部关闭由 reka 的 DismissableLayer 负责，落到 Popover 的 open 上 ——
 *     所以断言的是宿主转发的 close，而不是面板自己监听窗口事件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h, ref } from "vue";
import { Popover, PopoverTrigger } from "@/components/ui/popover";

const push = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@greywork/acp", () => ({
  createAcpClient: () => ({ isAvailable: () => true, onEvent: () => Promise.resolve(() => undefined) }) as never,
  desktopHomeDir: () => Promise.resolve("/home/test"),
}));

import SearchPanel from "@/features/workspace/SearchPanel.vue";
import { i18n } from "@/i18n";
import { appEvents } from "@/events";
import { useSessionStore } from "@/stores/session";
import { useWorkspaceStore } from "@/stores/workspace";

/** 宿主：模拟 Titlebar 持有 Popover，把面板的 close 与 popover 的 open=false 都归到 close 上。 */
const Host = defineComponent({
  components: { Popover, PopoverTrigger, SearchPanel },
  emits: ["close"],
  setup() {
    const open = ref(true);
    const onOpenChange = (next: boolean): void => {
      if (!next) open.value = false;
    };
    return { open, onOpenChange };
  },
  render() {
    return h(
      Popover,
      { open: this.open, "onUpdate:open": this.onOpenChange },
      {
        default: () => [
          h(PopoverTrigger, null, { default: () => "锚点" }),
          this.open ? h(SearchPanel, { onClose: () => this.$emit("close") }) : null,
        ],
      },
    );
  },
});

function workspace(id: string, name: string) {
  return { id, name, description: "", folder: undefined, files: [], createdAt: 1, updatedAt: 1, lastUsedAt: 1 };
}

function seed(): void {
  window.localStorage.setItem(
    "greywork.workspaces",
    JSON.stringify({
      version: 2,
      workspaces: [workspace("w-alpha", "Alpha 仓")],
      activeWorkspaceId: "w-alpha",
      defaultWorkspaceId: null,
    }),
  );
  window.localStorage.setItem(
    "greywork.sessions",
    JSON.stringify({
      version: 2,
      sessions: [
        {
          id: "s-a",
          title: "认证重构",
          workspaceId: "w-alpha",
          createdAt: 1,
          updatedAt: 20,
          messages: [{ id: "m1", role: "user", content: "补一下限流", ts: 1 }],
        },
        { id: "s-b", title: "周报", workspaceId: null, createdAt: 1, updatedAt: 10, messages: [] },
      ],
      activeSessionId: null,
    }),
  );
}

/** 宿主组件挂到 body 上，必须在用例结束后显式卸载 —— 直接清 innerHTML 会让
 *  Vue 卸载时去删已经不存在的父节点，报 unmount 错。 */
const mounted: VueWrapper[] = [];

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** 面板根节点（Portal 后落在 body 下）。 */
function panel(): DOMWrapper<Element> {
  const el = document.body.querySelector('[data-testid="search-panel"]');
  if (!el) throw new Error("未渲染出 search-panel");
  return new DOMWrapper(el);
}

/** 面板是否还在（Esc / 点外部关闭后由父级 v-if 卸掉）。 */
function panelExists(): boolean {
  return document.body.querySelector('[data-testid="search-panel"]') !== null;
}

function rows(): DOMWrapper<Element>[] {
  return [...document.body.querySelectorAll('[data-testid="search-result"]')].map((el) => new DOMWrapper(el));
}

beforeEach(() => {
  push.mockClear();
  window.localStorage.clear();
  seed();
  setActivePinia(createPinia());
  useWorkspaceStore();
  useSessionStore();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("SearchPanel", () => {
  it("空查询列出全部：会话在前、功能在后，并给出计数", async () => {
    await mountPanel();
    const labels = rows().map((row) => row.text());
    expect(labels.join("\n")).toContain("认证重构");
    expect(labels.join("\n")).toContain("周报");
    expect(labels.join("\n")).toContain("团队");
    expect(labels.join("\n")).toContain("MCP");
    expect(panel().find('[data-testid="search-count"]').text()).toContain("项");
  });

  it("关键词能命中会话正文（标题里没有的词也搜得到）", async () => {
    await mountPanel();
    await panel().find("input[role='combobox']").setValue("限流");
    const found = rows();
    expect(found).toHaveLength(1);
    expect(found[0]!.text()).toContain("认证重构");
  });

  it("类型筛选「功能」只剩导航与设置，并隐藏会话专属筛选", async () => {
    await mountPanel();
    await panel().find('[data-testid="search-type-feature"]').trigger("click");
    const kinds = rows().map((row) => row.attributes("data-kind"));
    expect(new Set(kinds)).toEqual(new Set(["nav", "settings"]));
    expect(panel().find('[data-testid="search-status-done"]').exists()).toBe(false);
  });

  it("状态筛选只剩该状态的会话", async () => {
    await mountPanel();
    await panel().find('[data-testid="search-status-done"]').trigger("click");
    const kinds = rows().map((row) => row.attributes("data-kind"));
    expect(new Set(kinds)).toEqual(new Set(["session"]));
  });

  it("工作区筛选：可只看某个工作区", async () => {
    await mountPanel();
    await panel().find('[data-testid="search-workspace"]').setValue("w-alpha");
    const found = rows();
    expect(found).toHaveLength(1);
    expect(found[0]!.text()).toContain("认证重构");
  });

  it("回车打开当前高亮项：会话跳路由并收起", async () => {
    const wrapper = await mountPanel();
    const emitSpy = vi.spyOn(appEvents, "emit");
    const input = panel().find("input[role='combobox']");

    await input.trigger("keydown", { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/conversation/s-a");
    expect(wrapper.emitted("close")).toBeTruthy();
    emitSpy.mockRestore();
  });

  it("设置命中发 settings:open 事件而不走路由", async () => {
    await mountPanel();
    const emitSpy = vi.spyOn(appEvents, "emit");
    await panel().find("input[role='combobox']").setValue("MCP");
    await rows()[0]!.trigger("click");
    expect(emitSpy).toHaveBeenCalledWith("settings:open", { section: "mcp" });
    expect(push).not.toHaveBeenCalled();
    emitSpy.mockRestore();
  });

  it("Esc 与外部点击都关闭；点面板内部不关闭", async () => {
    // 注意这里断言的是「面板没了」而不是 emit("close")：Esc / 点外部由 reka 关掉 Popover，
    // 父级 v-if 随之卸下面板 —— 那条路径上根本没人 emit close。只有选中结果才 emit（见上两条）。
    await mountPanel();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(panelExists()).toBe(false);

    // 点面板内部：DismissableLayer 判定为内部，不关
    await mountPanel();
    await panel().trigger("pointerdown");
    await flushPromises();
    expect(panelExists()).toBe(true);

    // 点面板外：关闭
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(panelExists()).toBe(false);
  });

  it("没有命中时给空态", async () => {
    await mountPanel();
    await panel().find("input[role='combobox']").setValue("绝对不存在的关键词");
    expect(panel().find('[data-testid="search-empty"]').exists()).toBe(true);
  });
});
