import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import MinimalSider from "@/features/shell/MinimalSider.vue";
import GroupedHistory from "@/features/workspace/GroupedHistory.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  // 只清 Portal 出来的弹层节点，不动 VTU 的挂载容器。
  document.body.innerHTML = "";
});

async function mountMinimalSider(props: Record<string, unknown> = {}) {
  const router = createAppRouter();
  await router.push("/guid");
  await router.isReady();
  return mount(MinimalSider, { props, global: { plugins: [router, i18n] } });
}

describe("MinimalSider 极简侧栏", () => {
  it("桌面：常驻（relative），不悬浮", async () => {
    const wrapper = await mountMinimalSider();
    expect(wrapper.get('[data-testid="grey-minimal-sider"]').classes()).toContain("relative");
    expect(wrapper.get('[data-testid="grey-minimal-sider"]').classes()).not.toContain("absolute");
  });

  it("窄屏 overlay：绝对定位抽屉（悬浮于内容之上）", async () => {
    const wrapper = await mountMinimalSider({ overlay: true });
    expect(wrapper.get('[data-testid="grey-minimal-sider"]').classes()).toContain("absolute");
    expect(wrapper.get('[data-testid="grey-minimal-sider"]').classes()).not.toContain("relative");
  });

  it("渲染品牌 + 快捷入口 + 「会话」段头 + 会话历史，无折叠轨道", async () => {
    const wrapper = await mountMinimalSider();

    expect(wrapper.find('[data-testid="grey-minimal-sider"]').exists()).toBe(true);
    // 快捷入口沿用 buildNavItems（内置三项），与完整 Sider 同源
    expect(wrapper.text()).toContain("团队");
    expect(wrapper.text()).toContain("自动化任务");
    // 「会话」段头（默认 zh-CN）
    expect(wrapper.get('[data-testid="grey-minimal-sider"]').text()).toContain("会话");
    expect(wrapper.find('[data-testid="minimal-session-sort"]').exists()).toBe(true);
    // 会话历史（GroupedHistory 自带「工作区」分组头）
    expect(wrapper.text()).toContain("工作区");
  });

  it("「新建」上报 newChat 意图", async () => {
    const wrapper = await mountMinimalSider();

    await wrapper.get('[data-testid="minimal-new-session"]').trigger("click");
    expect(wrapper.emitted("newChat")).toHaveLength(1);
  });

  it("页脚设置入口只上报 openSettings（极简也保留设置可达）", async () => {
    const wrapper = await mountMinimalSider();

    await wrapper.get('[data-testid="sider-settings"]').trigger("click");
    expect(wrapper.emitted("openSettings")).toHaveLength(1);
  });
});

describe("MinimalSider 会话排序 / 筛选", () => {
  /** Portal 到 body 的菜单项。 */
  function menuItem(testid: string): DOMWrapper<Element> {
    const element = document.body.querySelector(`[data-testid="${testid}"]`);
    expect(element, `菜单项 ${testid}`).not.toBeNull();
    return new DOMWrapper(element!);
  }

  it("排序菜单选「名称」后把 sort=title 转发给 GroupedHistory", async () => {
    const wrapper = await mountMinimalSider();
    expect(wrapper.getComponent(GroupedHistory).props("sort")).toBe("recent");

    await wrapper.get('[data-testid="minimal-session-sort"]').trigger("click");
    await flushPromises();
    await menuItem("minimal-sort-title").trigger("click");
    await flushPromises();

    expect(wrapper.getComponent(GroupedHistory).props("sort")).toBe("title");
    wrapper.unmount();
  });

  it("勾选「只看当前工作区」把 onlyActiveWorkspace=true 转发给 GroupedHistory", async () => {
    const wrapper = await mountMinimalSider();
    expect(wrapper.getComponent(GroupedHistory).props("onlyActiveWorkspace")).toBe(false);

    await wrapper.get('[data-testid="minimal-session-sort"]').trigger("click");
    await flushPromises();
    await menuItem("minimal-filter-only-active").trigger("click");
    await flushPromises();

    expect(wrapper.getComponent(GroupedHistory).props("onlyActiveWorkspace")).toBe(true);
    wrapper.unmount();
  });
});
