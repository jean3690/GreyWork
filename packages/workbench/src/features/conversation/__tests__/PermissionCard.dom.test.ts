// 权限卡片是无障碍语义的回归哨兵：
// 它是内联在消息流里的卡片（无遮罩、不抢焦点），因此必须是「带名字的控件组」，
// 不能是 alertdialog、更不能带 aria-modal —— 后者会告诉辅助技术「页面其余部分已失活」，
// 而身后的消息其实照样可见可操作。这条用例盯的就是这个判断不被改回去。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PermissionCard from "@/features/conversation/PermissionCard.vue";
import { useAgentStore } from "@/stores/agent";

/** 挂载过的 wrapper：卡片在有待确认请求时会起 250ms 倒计时 interval，卸载才清得掉。 */
const mounted: VueWrapper[] = [];

function mountCard(
  options: { name: string; optionId: string; kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[] = [
    { name: "Allow once", optionId: "allow" },
  ],
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const agent = useAgentStore();
  agent.pendingPermission = {
    requestId: 1,
    auto: false,
    chosen: null,
    toolCallId: "tool-1",
    title: "写入 /home/test/notes.md",
    kind: "edit",
    options: options.map((option) => ({ kind: "allow_once" as const, ...option })),
  };
  agent.permissionDeadline = Date.now() + 120_000;
  // 必须挂到 body：下面要靠 document.getElementById 校验 aria-labelledby 的指向。
  const wrapper = mount(PermissionCard, { global: { plugins: [pinia] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, agent };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = "";
});

describe("PermissionCard · 无障碍语义", () => {
  it("是带名字的 group，而不是 alertdialog / aria-modal", () => {
    const { wrapper } = mountCard();
    const card = wrapper.get('[data-testid="permission-card"]');

    expect(card.attributes("role")).toBe("group");
    expect(card.attributes("aria-modal")).toBeUndefined();
  });

  it("aria-labelledby 指向卡片内那行可见标题", () => {
    const { wrapper } = mountCard();
    const card = wrapper.get('[data-testid="permission-card"]');

    const labelledBy = card.attributes("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe("等待你确认");
  });

  it("无待确认请求时整卡不渲染", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(PermissionCard, { global: { plugins: [pinia] } });
    mounted.push(wrapper);

    expect(wrapper.find('[data-testid="permission-card"]').exists()).toBe(false);
  });

  it("每个裁决选项与「拒绝」都在卡片内可聚焦", () => {
    const { wrapper } = mountCard([
      { name: "Allow once", optionId: "allow-once" },
      { name: "Allow always", optionId: "allow-always" },
    ]);
    const card = wrapper.get('[data-testid="permission-card"]');

    const labels = card.findAll("button").map((button) => button.text());
    expect(labels).toContain("Allow once");
    expect(labels).toContain("Allow always");
    expect(labels).toContain("拒绝");
  });
});
