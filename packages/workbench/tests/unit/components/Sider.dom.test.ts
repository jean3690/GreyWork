import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import Sider from "@/components/Sider.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  setActivePinia(createPinia());
});

async function mountSider(collapsed: boolean) {
  const router = createAppRouter();
  await router.push("/guid");
  await router.isReady();
  return mount(Sider, {
    props: { collapsed },
    global: { plugins: [router, i18n] },
  });
}

describe("Sider 新对话入口", () => {
  it("展开时显示入口并向外发送新建意图", async () => {
    const wrapper = await mountSider(false);
    const button = wrapper.get('[data-testid="sider-new-chat"]');

    expect(button.text()).toContain("新对话");
    await button.trigger("click");
    expect(wrapper.emitted("newChat")).toHaveLength(1);
  });

  it("折叠时只保留品牌 logo，不显示新对话入口", async () => {
    const wrapper = await mountSider(true);

    expect(wrapper.find('[data-testid="sider-new-chat"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="grey-sider"]').classes()).toContain("w-[52px]");
    expect(wrapper.find('[data-testid="sider-brand-toggle"] img').exists()).toBe(true);
  });

  it("设置入口只上报打开设置弹窗，不再切换路由", async () => {
    const wrapper = await mountSider(false);
    const initialPath = wrapper.vm.$route.path;

    await wrapper.get('[data-testid="sider-settings"]').trigger("click");

    expect(wrapper.emitted("openSettings")).toHaveLength(1);
    expect(wrapper.vm.$route.path).toBe(initialPath);
  });
});
