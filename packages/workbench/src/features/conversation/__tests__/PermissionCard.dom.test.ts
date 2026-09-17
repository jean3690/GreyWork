// 权限卡片是无障碍语义的回归哨兵：
// 它是内联在消息流里的卡片（无遮罩、不抢焦点），因此必须是「带名字的控件组」，
// 不能是 alertdialog、更不能带 aria-modal —— 后者会告诉辅助技术「页面其余部分已失活」，
// 而身后的消息其实照样可见可操作。这条用例盯的就是这个判断不被改回去。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PermissionCard from "@/features/conversation/PermissionCard.vue";
import { useAgentStore } from "@/stores/agent";
import type { AcpPermissionRequestPayload } from "@greywork/acp";
import type { PermissionTrace } from "@/types";

/** 挂载过的 wrapper：卡片在有待确认请求时会起 250ms 倒计时 interval，卸载才清得掉。 */
const mounted: VueWrapper[] = [];

function mountCard(
  options: { name: string; optionId: string; kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[] = [
    { name: "Allow once", optionId: "allow" },
  ],
  payload: Partial<AcpPermissionRequestPayload> = {},
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
    ...payload,
  };
  agent.permissionDeadline = Date.now() + 120_000;
  // 必须挂到 body：下面要靠 document.getElementById 校验 aria-labelledby 的指向。
  const wrapper = mount(PermissionCard, { global: { plugins: [pinia] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, agent };
}

/** 只读态：直接把留痕当 prop 传进去（消息流里的回看形态）。 */
function mountTrace(trace: PermissionTrace) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(PermissionCard, { props: { trace }, global: { plugins: [pinia] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
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

  it("agent 自带 reject 选项时不再补一个「拒绝」——并排两个拒绝只会让人停下来读", () => {
    const { wrapper } = mountCard([
      { name: "Allow once", optionId: "once", kind: "allow_once" },
      { name: "Reject", optionId: "reject", kind: "reject_once" },
    ]);
    const card = wrapper.get('[data-testid="permission-card"]');

    expect(card.find('[data-testid="permission-deny"]').exists()).toBe(false);
    const labels = card.findAll("button").map((button) => button.text());
    expect(labels).toContain("Reject");
    expect(labels).not.toContain("拒绝");
  });

  it("按意图分色：allow 与 reject 拿到不同的 testid 钩子", () => {
    const { wrapper } = mountCard([
      { name: "Allow once", optionId: "once", kind: "allow_once" },
      { name: "Always allow", optionId: "always", kind: "allow_always" },
      { name: "Reject", optionId: "reject", kind: "reject_once" },
    ]);
    const card = wrapper.get('[data-testid="permission-card"]');

    expect(card.find('[data-testid="permission-option-allow-once"]').exists()).toBe(true);
    expect(card.find('[data-testid="permission-option-allow-always"]').exists()).toBe(true);
    expect(card.find('[data-testid="permission-option-reject-once"]').exists()).toBe(true);
  });

  it("显示工具类别、命令正文、涉及路径与 toolCallId —— 用户得知道自己在批什么", () => {
    const { wrapper } = mountCard(undefined, {
      kind: "execute",
      toolCallId: "call_abc123",
      title: "rm -rf build",
      locations: ["/home/test/build"],
      rawInput: { command: "rm -rf build" },
    });

    expect(wrapper.get('[data-testid="permission-kind"]').text()).toContain("执行命令");
    expect(wrapper.get('[data-testid="permission-command"]').text()).toBe("rm -rf build");
    expect(wrapper.get('[data-testid="permission-paths"]').text()).toContain("/home/test/build");
    expect(wrapper.get('[data-testid="permission-card"]').text()).toContain("call_abc123");
  });

  it("认不出的 rawInput 不渲染命令块——不猜键名，也不吐 undefined", () => {
    const { wrapper } = mountCard(undefined, { kind: "execute", rawInput: { script: "echo hi" } });

    expect(wrapper.find('[data-testid="permission-command"]').exists()).toBe(false);
  });
});

describe("PermissionCard · 只读留痕", () => {
  const trace: PermissionTrace = {
    toolCallId: "tc-1",
    title: "/home/test/notes.md",
    kind: "edit",
    paths: ["/home/test/notes.md"],
    command: null,
    choice: "允许一次",
    source: "user",
    decidedAt: 1,
  };

  it("有留痕时渲染只读记录，不再渲染待确认卡片", () => {
    const wrapper = mountTrace(trace);

    expect(wrapper.find('[data-testid="permission-trace"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="permission-trace-badge"]').text()).toContain("允许一次");
    expect(wrapper.find('[data-testid="permission-card"]').exists()).toBe(false);
    // 只读态是纯展示：不该有任何可点按钮（否则用户会以为还能改判）
    expect(wrapper.findAll("button")).toHaveLength(0);
  });

  it("拒绝的留痕标「已拒绝」而不是空白 choice", () => {
    const wrapper = mountTrace({ ...trace, choice: null, source: "timeout" });

    expect(wrapper.get('[data-testid="permission-trace-badge"]').text()).toBe("超时已取消");
  });

  it("免问直答的留痕说明来源（按你的「始终允许」放行）", () => {
    const wrapper = mountTrace({ ...trace, source: "auto" });

    expect(wrapper.get('[data-testid="permission-trace-badge"]').text()).toContain("始终允许");
  });
});
