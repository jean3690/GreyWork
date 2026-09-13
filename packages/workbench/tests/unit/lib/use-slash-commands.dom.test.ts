// 斜杠命令组合式契约：触发与过滤、方向键循环、选中语义（模板填充 / 开关 / ACP 插入或直发）、
// Esc 关闭保持、IME 放行。
import { beforeEach, describe, expect, it } from "vitest";
import { defineComponent, ref } from "vue";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useSlashCommands, type UseSlashCommands } from "@/lib/use-slash-commands";
import { useAgentStore } from "@/stores/agent";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { i18n } from "@/i18n";

interface HarnessVm {
  draft: string;
  sent: string[];
  canSend: boolean;
  slash: UseSlashCommands;
}

/** 最小输入壳：只有 textarea + 组合式，模拟视图里 onSend 的「补文本再发」语义。 */
const Harness = defineComponent({
  setup() {
    const draft = ref("");
    const textarea = ref<HTMLTextAreaElement | null>(null);
    const sent: string[] = [];
    const canSend = ref(true);
    const slash = useSlashCommands({
      draft,
      textarea,
      onSend: (text) => {
        sent.push(text);
        draft.value = "";
      },
      canSend: () => canSend.value,
    });
    return { draft, textarea, sent, canSend, slash };
  },
  template: `<div><textarea ref="textarea" v-model="draft"></textarea></div>`,
});

function mountHarness(): { wrapper: VueWrapper; vm: HarnessVm; textarea: () => HTMLTextAreaElement } {
  const pinia = createPinia();
  setActivePinia(pinia);
  // attachTo：焦点断言需要元素真的在 document 里。
  const wrapper = mount(Harness, { attachTo: document.body, global: { plugins: [pinia, i18n] } });
  return {
    wrapper,
    vm: wrapper.vm as unknown as HarnessVm,
    textarea: () => wrapper.get("textarea").element as HTMLTextAreaElement,
  };
}

/** happy-dom 下构造可指定 keyCode 的键盘事件（229 = IME 合成）。 */
function key(keyName: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: keyName, cancelable: true, ...extra });
}

function keyCode229(): KeyboardEvent {
  const event = key("Enter");
  Object.defineProperty(event, "keyCode", { value: 229 });
  return event;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("斜杠命令 · 触发与过滤", () => {
  it("行首 / 打开菜单并列出内置命令，继续打字按名称过滤", async () => {
    const { wrapper, vm } = mountHarness();
    await wrapper.get("textarea").setValue("/");
    expect(vm.slash.open.value).toBe(true);
    expect(vm.slash.items.value.map((item) => item.name)).toEqual(["plan", "speed", "test", "report", "review", "search", "genui"]);

    await wrapper.get("textarea").setValue("/re");
    expect(vm.slash.items.value.map((item) => item.name)).toEqual(["report", "review"]);

    await wrapper.get("textarea").setValue("/zzz");
    expect(vm.slash.open.value).toBe(true);
    expect(vm.slash.items.value).toEqual([]);
  });

  it("不在行首 / 已输入空格 / 清空草稿都不打开", async () => {
    const { wrapper, vm } = mountHarness();
    await wrapper.get("textarea").setValue("hello /pl");
    expect(vm.slash.open.value).toBe(false);

    await wrapper.get("textarea").setValue("/pl x");
    expect(vm.slash.open.value).toBe(false);

    await wrapper.get("textarea").setValue("");
    expect(vm.slash.open.value).toBe(false);
  });
});

describe("斜杠命令 · 键盘导航", () => {
  it("方向键循环高亮，Enter 选中模板命令并回填草稿", async () => {
    const { wrapper, vm } = mountHarness();
    await wrapper.get("textarea").setValue("/");
    expect(vm.slash.activeIndex.value).toBe(0);

    expect(vm.slash.handleKeydown(key("ArrowDown"))).toBe(true);
    expect(vm.slash.activeIndex.value).toBe(1);
    expect(vm.slash.handleKeydown(key("ArrowUp"))).toBe(true);
    expect(vm.slash.handleKeydown(key("ArrowUp"))).toBe(true);
    expect(vm.slash.activeIndex.value).toBe(6); // 首项向上回绕到末项

    await wrapper.get("textarea").setValue("/rep");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(true);
    expect(vm.draft).toBe(i18n.global.t("chat.commands.report.template"));
    expect(vm.slash.open.value).toBe(false);
  });

  it("Tab 等同 Enter；无匹配时 Enter 不消费（留给视图原样发送）", async () => {
    const { wrapper, vm } = mountHarness();
    await wrapper.get("textarea").setValue("/gen");
    expect(vm.slash.handleKeydown(key("Tab"))).toBe(true);
    expect(vm.draft).toBe(i18n.global.t("chat.commands.genui.template"));

    await wrapper.get("textarea").setValue("/zzz");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(false);
  });

  it("Esc 关闭后继续打字不弹回，离开斜杠形态再输入可重新打开", async () => {
    const { wrapper, vm } = mountHarness();
    await wrapper.get("textarea").setValue("/pl");
    expect(vm.slash.handleKeydown(key("Escape"))).toBe(true);
    expect(vm.slash.open.value).toBe(false);

    await wrapper.get("textarea").setValue("/pla");
    expect(vm.slash.open.value).toBe(false);

    await wrapper.get("textarea").setValue("pl");
    await wrapper.get("textarea").setValue("/");
    expect(vm.slash.open.value).toBe(true);
  });

  it("IME 合成中的 Enter 不消费，菜单保持", async () => {
    const { wrapper, vm } = mountHarness();
    await wrapper.get("textarea").setValue("/pl");
    expect(vm.slash.handleKeydown(keyCode229())).toBe(false);
    expect(vm.slash.open.value).toBe(true);
    expect(vm.draft).toBe("/pl");
  });

  it("菜单关闭时任何键都不消费", async () => {
    const { vm } = mountHarness();
    expect(vm.slash.handleKeydown(key("ArrowDown"))).toBe(false);
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(false);
  });
});

describe("斜杠命令 · 选中执行", () => {
  it("/plan 与 /speed 直接翻转开关并清空草稿", async () => {
    const { wrapper, vm } = mountHarness();
    const settings = useSettingsStore();
    const chat = useChatStore();

    await wrapper.get("textarea").setValue("/plan");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(true);
    expect(settings.planMode).toBe(true);
    expect(vm.draft).toBe("");

    await wrapper.get("textarea").setValue("/speed");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(true);
    expect(chat.speedBoost).toBe(true);
    expect(vm.draft).toBe("");
  });

  it("ACP 带参命令插入 /name 与空格，等用户补参数", async () => {
    const { wrapper, vm } = mountHarness();
    const agent = useAgentStore();
    agent.routeToAcp = true;
    agent.acpCommands = [{ name: "deploy", description: "部署", input: { hint: "环境名" } }];

    await wrapper.get("textarea").setValue("/dep");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(true);
    expect(vm.draft).toBe("/deploy ");
    expect(vm.sent).toEqual([]);
    expect(vm.slash.open.value).toBe(false);
  });

  it("ACP 无参命令选中即发，走视图 onSend", async () => {
    const { wrapper, vm } = mountHarness();
    const agent = useAgentStore();
    agent.routeToAcp = true;
    agent.acpCommands = [{ name: "compact", description: "压缩上下文" }];

    await wrapper.get("textarea").setValue("/com");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(true);
    expect(vm.sent).toEqual(["/compact"]);
    expect(vm.draft).toBe("");
    expect(vm.slash.open.value).toBe(false);
  });

  it("不可发送时 ACP 无参命令降级为插入待发", async () => {
    const { wrapper, vm } = mountHarness();
    const agent = useAgentStore();
    agent.routeToAcp = true;
    agent.acpCommands = [{ name: "compact", description: "压缩上下文" }];
    vm.canSend = false;
    await wrapper.vm.$nextTick();

    await wrapper.get("textarea").setValue("/com");
    expect(vm.slash.handleKeydown(key("Enter"))).toBe(true);
    expect(vm.sent).toEqual([]);
    expect(vm.draft).toBe("/compact ");
  });

  it("未走 ACP 路由时不出现 agent 命令", async () => {
    const { wrapper, vm } = mountHarness();
    const agent = useAgentStore();
    agent.acpCommands = [{ name: "compact", description: "压缩上下文" }];

    await wrapper.get("textarea").setValue("/com");
    expect(vm.slash.items.value).toEqual([]);
  });
});

/** 选中后回焦输入框（模板/插入路径）。 */
describe("斜杠命令 · 焦点", () => {
  it("选中后回焦 textarea 且光标在末尾", async () => {
    const { wrapper, vm, textarea } = mountHarness();
    await wrapper.get("textarea").setValue("/rep");
    vm.slash.select(0);
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    const el = textarea();
    expect(document.activeElement).toBe(el);
    expect(el.selectionStart).toBe(el.value.length);
  });
});
