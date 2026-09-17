// 团队页契约：协作启动区默认三名成员（Leader/Builder/Reviewer）；「添加成员」加一行输入。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TeamView from "@/features/team/TeamView.vue";
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

describe("TeamView 成员职能标签", () => {
  async function mountTeam() {
    const router = createAppRouter();
    await router.push("/team");
    await router.isReady();
    return mount(TeamView, { global: { plugins: [router, i18n] } });
  }

  it("teammate 行渲染职能下拉（默认 2 个 teammate），leader 行不渲染", async () => {
    const wrapper = await mountTeam();
    const specialty = wrapper.findAll('[data-testid="member-specialty"]');
    expect(specialty).toHaveLength(2); // Builder / Reviewer

    // 含「无」与四档职能（本地化文案）
    const texts = specialty[0]!.findAll("option").map((option) => option.text());
    const none = i18n.global.t("cowork.specialty.none");
    const builder = i18n.global.t("cowork.specialty.builder");
    const reviewer = i18n.global.t("cowork.specialty.reviewer");
    expect(texts).toContain(none);
    expect(texts).toContain(builder);
    expect(texts).toContain(reviewer);
    // 默认 Builder→builder、Reviewer→reviewer（首选项选中态）
    const selected = specialty.map((select) => (select.element as HTMLSelectElement).value);
    expect(selected).toEqual(["builder", "reviewer"]);

    // 三行角色：第一行 leader 无职能下拉
    const roles = wrapper.findAll('[data-testid="member-role"]');
    expect(roles).toHaveLength(3);
    expect((roles[0]!.element as HTMLSelectElement).value).toBe("leader");
  });

  it("成员位从 teammate 切到 leader 时职能下拉消失，切回出现", async () => {
    const wrapper = await mountTeam();
    const roles = wrapper.findAll('[data-testid="member-role"]');
    expect(wrapper.findAll('[data-testid="member-specialty"]')).toHaveLength(2);

    await roles[1]!.setValue("leader");
    expect(wrapper.findAll('[data-testid="member-specialty"]')).toHaveLength(1);

    await roles[1]!.setValue("teammate");
    expect(wrapper.findAll('[data-testid="member-specialty"]')).toHaveLength(2);
  });

  it("新增成员默认为 teammate，带职能下拉", async () => {
    const wrapper = await mountTeam();
    const addLabel = i18n.global.t("cowork.addMember");
    const add = wrapper.findAll("button").find((button) => button.text().includes(addLabel));
    await add!.trigger("click");

    expect(wrapper.findAll('[data-testid="member-specialty"]')).toHaveLength(3);
  });
});
