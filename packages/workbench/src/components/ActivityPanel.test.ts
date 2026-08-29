// @vitest-environment happy-dom
// 首个组件用例：标签栏拆分 /「更多」下拉。此前 src/views 与组件层整体 0% 覆盖，
// 根因是缺 @vue/test-utils 与 DOM 环境（见 package.json devDependencies）。
// 这里注册最小 manifest（空 pane）而非 coreBuiltinManifest —— 真实 pane 会拖入
// pinia / Tauri / Univer 等重依赖，本用例只验标签分发逻辑本身。
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import ActivityPanel from "./ActivityPanel.vue";
import { capabilitySeam } from "../plugins/loader";
import { coreBuiltinManifest } from "../plugins/registry";
import { i18n } from "../i18n";

const pane = (text: string) => defineComponent({ render: () => h("div", { class: "pane" }, text) });

/** 3 个常驻标签 + 2 个 overflow 标签，模拟真实登记结构。 */
function registerTestPanels(): void {
  capabilitySeam.register({
    id: "test.panels",
    name: "测试面板",
    version: "0.1.0",
    contributes: {
      uiRegions: [
        { region: "activityPanel", id: "t.files", title: "panels.file", component: pane("FILES"), order: 5 },
        { region: "activityPanel", id: "t.diffs", title: "panels.diffs.title", component: pane("DIFFS"), order: 10 },
        { region: "activityPanel", id: "t.term", title: "panels.terminal.title", component: pane("TERM"), order: 30 },
        { region: "activityPanel", id: "t.review", title: "panels.review.title", component: pane("REVIEW"), order: 50, overflow: true },
        { region: "activityPanel", id: "t.sources", title: "panels.sources.title", component: pane("SOURCES"), order: 60, overflow: true },
      ],
    },
  });
}

describe("ActivityPanel", () => {
  beforeEach(async () => {
    if (!capabilitySeam.activeIds().includes("test.panels")) {
      registerTestPanels();
      await capabilitySeam.activate("test.panels");
    }
  });

  it("只把非 overflow 面板渲染成常驻标签，其余收进「更多」", async () => {
    const wrapper = mount(ActivityPanel, { props: { open: true }, global: { plugins: [i18n] } });
    const tabs = wrapper.findAll(".side__tabs .side__tab");
    expect(tabs).toHaveLength(3);
    expect(wrapper.find(".side__more-btn").exists()).toBe(true);
    // 菜单默认收起，overflow 面板不占标签位
    expect(wrapper.find(".side__more-pop").exists()).toBe(false);
  });

  it("open=false 时不渲染面板", () => {
    const wrapper = mount(ActivityPanel, { props: { open: false }, global: { plugins: [i18n] } });
    expect(wrapper.find(".side__tabbar").exists()).toBe(false);
  });

  it("点「更多」展开下拉，选中后切换面板并收起", async () => {
    const wrapper = mount(ActivityPanel, { props: { open: true }, global: { plugins: [i18n] } });
    expect(wrapper.find(".pane").text()).toBe("FILES");

    await wrapper.find(".side__more-btn").trigger("click");
    const opts = wrapper.findAll(".side__more-opt");
    expect(opts).toHaveLength(2);
    expect(opts.map((o) => o.text())).toEqual(["Review", "Sources"]);

    await opts[0].trigger("click");
    expect(wrapper.find(".side__more-pop").exists()).toBe(false);
    expect(wrapper.find(".pane").text()).toBe("REVIEW");
    // 「更多」按钮自身进入激活态，提示当前激活项在菜单里
    expect(wrapper.find(".side__more-btn").classes()).toContain("active");
  });
});

describe("coreBuiltinManifest 面板登记", () => {
  it("Review / Sources 标记为 overflow，其余为常驻标签", () => {
    const regions = coreBuiltinManifest.contributes?.uiRegions?.filter((r) => r.region === "activityPanel") ?? [];
    const overflowIds = regions.filter((r) => r.overflow).map((r) => r.id);
    expect(overflowIds).toEqual(["activity.review", "activity.sources"]);
    expect(regions.filter((r) => !r.overflow)).toHaveLength(6);
  });
});
