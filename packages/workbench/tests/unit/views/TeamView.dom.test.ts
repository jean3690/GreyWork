// 团队页契约：协作启动区默认三名成员（Leader/Builder/Reviewer）；「添加成员」加一行输入。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TeamView from "@/views/TeamView.vue";
import { createAppRouter } from "@/router";
import { i18n } from "@/i18n";

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
});

describe("TeamView", () => {
  it("渲染协作标题与起跑表单（默认 3 个成员位）", async () => {
    const router = createAppRouter();
    await router.push("/team");
    await router.isReady();
    const title = i18n.global.t("cowork.title");

    const wrapper = mount(TeamView, { global: { plugins: [router, i18n] } });
    expect(wrapper.text()).toContain(title);
    // 成员名输入框（Leader / Builder / Reviewer）
    const placeholder = i18n.global.t("cowork.memberNamePlaceholder");
    expect(wrapper.findAll(`input[placeholder="${placeholder}"]`)).toHaveLength(3);
  });

  it("添加成员：行数 3 → 4", async () => {
    const router = createAppRouter();
    await router.push("/team");
    await router.isReady();

    const wrapper = mount(TeamView, { global: { plugins: [router, i18n] } });
    const placeholder = i18n.global.t("cowork.memberNamePlaceholder");
    const addLabel = i18n.global.t("cowork.addMember");
    const add = wrapper.findAll("button").find((button) => button.text().includes(addLabel));
    expect(add).toBeDefined();
    await add!.trigger("click");

    expect(wrapper.findAll(`input[placeholder="${placeholder}"]`)).toHaveLength(4);
  });
});
