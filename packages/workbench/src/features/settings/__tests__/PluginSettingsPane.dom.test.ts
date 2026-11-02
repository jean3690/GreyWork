import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

// DOM 环境自带 localStorage；capabilities 在导入时读一次，resetStorageKvForTest 会清干净。
const market = vi.hoisted(() => ({ installedMarketPlugins: { value: [] as unknown[] } }));
const enabled = vi.hoisted(() => ({ isPluginEnabled: vi.fn(() => true) }));

vi.mock("@/plugins/market", () => ({ installedMarketPlugins: market.installedMarketPlugins }));
vi.mock("@/plugins/runtime", () => ({ isPluginEnabled: enabled.isPluginEnabled }));

import { i18n } from "@/i18n";
import PluginSettingsPane from "@/features/settings/PluginSettingsPane.vue";
import { readPluginKv, resetStorageKvForTest } from "@/plugins/capabilities";

function packageWithSchema(id = "demo.cfg", name = "配置插件"): unknown {
  return {
    code: "",
    manifest: {
      id,
      name,
      version: "1.0.0",
      kind: "declarative",
      requires: [],
      contributes: {
        modes: [],
        settingsSchema: [
          { key: "api_base", label: "接口地址", kind: "text", default: "https://example.com", maxLength: 20 },
          { key: "interval", label: "间隔", kind: "number", default: 15, min: 5, max: 60, step: 5 },
          { key: "enabled", label: "启用", kind: "toggle", default: true },
        ],
      },
    },
  };
}

beforeEach(() => {
  resetStorageKvForTest();
  enabled.isPluginEnabled.mockReturnValue(true);
  market.installedMarketPlugins.value = [packageWithSchema()];
});

describe("PluginSettingsPane", () => {
  it("把声明的字段渲染出来，并显示默认值", async () => {
    const wrapper = mount(PluginSettingsPane, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.get('[data-testid="plugin-settings-demo.cfg"]').text()).toContain("配置插件");
    const text = wrapper.get('[data-testid="plugin-setting-demo.cfg-api_base"] input').element as HTMLInputElement;
    const number = wrapper.get('[data-testid="plugin-setting-demo.cfg-interval"] input').element as HTMLInputElement;
    const toggle = wrapper.get('[data-testid="plugin-setting-demo.cfg-enabled"] input').element as HTMLInputElement;
    expect(text.value).toBe("https://example.com");
    expect(number.value).toBe("15");
    expect(toggle.checked).toBe(true);
  });

  it("改文本写进插件 KV（与 storage.kv 同一命名空间）", async () => {
    const wrapper = mount(PluginSettingsPane, { global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-testid="plugin-setting-demo.cfg-api_base"] input').setValue("https://grey.local");
    expect(readPluginKv("demo.cfg", "api_base")).toBe("https://grey.local");
    expect(wrapper.get('[data-testid="plugin-settings-saved"]').exists()).toBe(true);
  });

  it("数字按声明的 min/max 夹紧，开关写布尔", async () => {
    const wrapper = mount(PluginSettingsPane, { global: { plugins: [i18n] } });
    await flushPromises();

    await wrapper.get('[data-testid="plugin-setting-demo.cfg-interval"] input').setValue("999");
    expect(readPluginKv("demo.cfg", "interval")).toBe(60);

    await wrapper.get('[data-testid="plugin-setting-demo.cfg-enabled"] input').setValue(false);
    expect(readPluginKv("demo.cfg", "enabled")).toBe(false);
  });

  it("停用的插件不出现；没有声明设置项时给空态", async () => {
    enabled.isPluginEnabled.mockReturnValue(false);
    const disabled = mount(PluginSettingsPane, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(disabled.find('[data-testid="plugin-settings-demo.cfg"]').exists()).toBe(false);
    expect(disabled.get('[data-testid="plugin-settings-empty"]').exists()).toBe(true);

    enabled.isPluginEnabled.mockReturnValue(true);
    market.installedMarketPlugins.value = [
      { code: "", manifest: { id: "demo.plain", name: "普通", version: "1.0.0", requires: [], contributes: { modes: [] } } },
    ];
    const plain = mount(PluginSettingsPane, { global: { plugins: [i18n] } });
    await flushPromises();
    expect(plain.get('[data-testid="plugin-settings-empty"]').exists()).toBe(true);
  });
});
