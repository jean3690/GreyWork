// Telegram 扫码面板契约：未配置 → BotFather 引导码；已配置 → 机器人绑定码 + 绑定态；
// 取链接失败 → 说明原因并可重试。平台能力边界写在组件注释里，这里只钉行为。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TelegramQrPanel from "@/features/channels/TelegramQrPanel.vue";
import { i18n } from "@/i18n";
import { useRemoteAssistantStore } from "@/stores/remote-assistant";

const mocks = vi.hoisted(() => ({
  telegram: {
    supported: vi.fn(() => true),
    status: vi.fn(async () => ({
      configured: false,
      state: "stopped" as const,
      detail: null,
      lastMessageAt: null,
      peerCount: 0,
    })),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    botLink: vi.fn(async () => ({ username: "greywork_bot", name: "GreyWork", url: "https://t.me/greywork_bot" })),
    onState: vi.fn(async () => () => {}),
    onInbound: vi.fn(async () => () => {}),
  },
}));

vi.mock("@/lib/telegram-backend", () => ({ telegramBackend: mocks.telegram }));
// `store.available` 的来源是微信通道的 supported()：不 mock 时浏览器态恒为 false，
// 宿主类动作会整体短路——这里只要它报「桌面可用」。
vi.mock("@/lib/wechat-backend", () => ({ wechatBackend: { supported: () => true } }));

const mounted: VueWrapper[] = [];

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

function render(): VueWrapper {
  const wrapper = mount(TelegramQrPanel, { global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

/**
 * 直接摆一个「已保存 token」的宿主状态（面板只看这一份状态）。
 * 就地改字段而不是整体替换：替换会绕开 ref 的写入路径，组件拿不到更新。
 */
function markConfigured(peerCount = 0): void {
  Object.assign(useRemoteAssistantStore().telegramStatus, {
    configured: true,
    state: "connected",
    detail: null,
    lastMessageAt: null,
    peerCount,
  });
}

describe("TelegramQrPanel", () => {
  it("未配置 token：给 BotFather 的引导码，不去问宿主取机器人链接", async () => {
    const wrapper = render();
    await flushPromises();

    expect(wrapper.find('[data-testid="telegram-botfather-qr"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="telegram-bind-qr"]').exists()).toBe(false);
    expect(mocks.telegram.botLink).not.toHaveBeenCalled();
  });

  it("已配置：出机器人绑定码（t.me 链接来自宿主 getMe）与等待态", async () => {
    markConfigured();
    const wrapper = render();
    await flushPromises();

    expect(mocks.telegram.botLink).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="telegram-bind-qr"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="telegram-bind-url"]').text()).toContain("https://t.me/greywork_bot");
    expect(wrapper.get('[data-testid="telegram-bind-state"]').text()).toContain("等待第一条消息");
  });

  it("已收到消息 = 绑定完成，显示联系人数", async () => {
    markConfigured(2);
    const wrapper = render();
    await flushPromises();

    const state = wrapper.get('[data-testid="telegram-bind-state"]');
    expect(state.text()).toContain("已绑定");
    expect(state.text()).toContain("2");
  });

  it("保存 token 后（configured 变真）就地切成绑定码，无需重开弹窗", async () => {
    const wrapper = render();
    await flushPromises();
    expect(wrapper.find('[data-testid="telegram-botfather-qr"]').exists()).toBe(true);

    markConfigured();
    await flushPromises();

    expect(wrapper.find('[data-testid="telegram-bind-qr"]').exists()).toBe(true);
    expect(mocks.telegram.botLink).toHaveBeenCalledTimes(1);
  });

  it("取链接失败：给出原因与重试入口", async () => {
    mocks.telegram.botLink.mockRejectedValueOnce(new Error("尚未配置 Telegram bot token"));
    markConfigured();
    const wrapper = render();
    await flushPromises();

    expect(wrapper.get('[data-testid="telegram-bind-error"]').text()).toContain("尚未配置 Telegram bot token");
    expect(wrapper.find('[data-testid="telegram-bind-qr"]').exists()).toBe(false);

    await wrapper.get('[data-testid="telegram-bind-retry"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="telegram-bind-qr"]').exists()).toBe(true);
  });
});
