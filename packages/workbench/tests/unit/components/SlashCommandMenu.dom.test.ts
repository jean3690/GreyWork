// 斜杠命令菜单组件契约：listbox/option 语义、高亮跟随、空态、点击/悬停事件、mousedown 保焦点。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import SlashCommandMenu from "@/components/chat/SlashCommandMenu.vue";
import type { SlashCommandItem } from "@/lib/slash-commands";
import { i18n } from "@/i18n";

const items: SlashCommandItem[] = [
  {
    id: "builtin:plan",
    name: "plan",
    description: "先拆解任务给出方案",
    source: "builtin",
    builtinKind: "toggle",
    requiresInput: false,
    active: true,
  },
  {
    id: "builtin:test",
    name: "test",
    description: "运行测试并汇总结果",
    source: "builtin",
    builtinKind: "template",
    templateKey: "chat.commands.test.template",
    requiresInput: false,
  },
  { id: "acp:deploy", name: "deploy", description: "部署", source: "acp", requiresInput: true, hint: "环境名" },
];

function mountMenu(activeIndex = 0, list: SlashCommandItem[] = items) {
  return mount(SlashCommandMenu, { props: { items: list, activeIndex }, global: { plugins: [i18n] } });
}

describe("SlashCommandMenu", () => {
  it("渲染 listbox 与全部选项，高亮跟随 activeIndex", () => {
    const wrapper = mountMenu(1);
    expect(wrapper.get('[role="listbox"]').attributes("aria-label")).toBe(i18n.global.t("chat.slash.menuAria"));

    const options = wrapper.findAll('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.attributes("aria-selected"))).toEqual(["false", "true", "false"]);
    // option id 与组合式的 aria-activedescendant 对齐
    expect(options[1]?.attributes("id")).toBe("slash-option-builtin-test");
  });

  it("模板命令带「模板」徽标，ACP 带参命令展示 hint，开关开启项打勾", () => {
    const wrapper = mountMenu(0);
    const options = wrapper.findAll('[role="option"]');
    expect(options[0]?.find('[data-testid="slash-badge-template"]').exists()).toBe(false);
    expect(options[0]?.text()).toContain("/plan");
    expect(options[0]?.find("svg").exists()).toBe(true); // active → check 图标
    expect(options[1]?.find('[data-testid="slash-badge-template"]').text()).toBe(i18n.global.t("chat.slash.badgeTemplate"));
    expect(options[2]?.text()).toContain("环境名");
  });

  it("空列表渲染空态文案", () => {
    const wrapper = mountMenu(0, []);
    expect(wrapper.text()).toContain(i18n.global.t("chat.slash.empty"));
    expect(wrapper.findAll('[role="option"]')).toHaveLength(0);
  });

  it("点击选项 emit select，悬停 emit update:activeIndex", async () => {
    const wrapper = mountMenu(0);
    const options = wrapper.findAll('[role="option"]');
    await options[2]!.trigger("click");
    expect(wrapper.emitted("select")).toEqual([[2]]);

    await options[1]!.trigger("mouseenter");
    expect(wrapper.emitted("update:activeIndex")).toEqual([[1]]);
  });

  it("mousedown 被 preventDefault（点击选项时输入框不失焦）", () => {
    const wrapper = mountMenu(0);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    wrapper.findAll('[role="option"]')[0]!.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("高亮变化时把选项滚进可视区（无 scrollIntoView 环境不报错）", async () => {
    const wrapper = mountMenu(0);
    await wrapper.setProps({ activeIndex: 2 });
    expect(wrapper.findAll('[role="option"]')[2]?.attributes("aria-selected")).toBe("true");
  });
});
