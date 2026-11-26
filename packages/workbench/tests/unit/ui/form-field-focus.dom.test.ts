import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { InputGroup, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group";

const fields = [
  { name: "Input", component: Input, selector: "input" },
  { name: "Textarea", component: Textarea, selector: "textarea" },
];

describe("表单输入框的单边框焦点样式", () => {
  it.each(fields)("$name 聚焦只强调自身边框，不叠加外圈", ({ component, selector }) => {
    const wrapper = mount(component);
    const classes = wrapper.get(selector).classes();

    expect(classes).toContain("border");
    expect(classes).toContain("focus-visible:border-ring");
    expect(classes).toContain("outline-hidden");
    expect(classes.some((name) => name.startsWith("focus-visible:ring-"))).toBe(false);
    wrapper.unmount();
  });

  it.each(fields)("$name 保留输入事件与错误状态", async ({ component, selector }) => {
    const wrapper = mount(component, { attrs: { "aria-invalid": "true", placeholder: "请输入" } });
    const control = wrapper.get(selector);

    expect(control.attributes("aria-invalid")).toBe("true");
    expect(control.attributes("placeholder")).toBe("请输入");
    expect(control.classes()).toContain("aria-invalid:border-destructive");
    await control.setValue("测试输入");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["测试输入"]);
    wrapper.unmount();
  });

  it.each(fields)("$name 保留禁用状态", ({ component, selector }) => {
    const wrapper = mount(component, { attrs: { disabled: true } });

    expect(wrapper.get(selector).attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it.each([
    { name: "InputGroupInput", component: InputGroupInput, selector: "input" },
    { name: "InputGroupTextarea", component: InputGroupTextarea, selector: "textarea" },
  ])("$name 由组合框外层承载边框，内部保持无边框", ({ component, selector }) => {
    const wrapper = mount(InputGroup, { slots: { default: component } });
    const classes = wrapper.classes();

    expect(classes).toContain("has-[[data-slot=input-group-control]:focus-visible]:border-ring");
    expect(classes).toContain("has-[[data-slot][aria-invalid=true]]:border-destructive");
    expect(classes.some((name) => name.includes(":ring-"))).toBe(false);
    expect(wrapper.get(selector).classes()).toContain("border-0");
    expect(wrapper.get(selector).attributes("data-slot")).toBe("input-group-control");
    wrapper.unmount();
  });
});
