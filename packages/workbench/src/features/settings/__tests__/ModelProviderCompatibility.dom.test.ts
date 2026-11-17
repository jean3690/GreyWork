import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";

const h = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })) }));
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasHostCommands: () => true,
  invoke: h.invoke,
}));
import ModelProviderCompatibility from "../ModelProviderCompatibility.vue";

let wrapper: VueWrapper;
const mountForm = () =>
  (wrapper = mount(ModelProviderCompatibility, {
    props: {
      stream: false,
      extraBodyText: '{"top_p":0.8}',
      connection: { baseUrl: "https://gateway.example/openai", model: "custom", apiKeyEnv: "" },
    },
  }));
afterEach(() => {
  wrapper?.unmount();
  h.invoke.mockReset();
  h.invoke.mockResolvedValue({ ok: true });
});

describe("第三方模型兼容性设置", () => {
  it("用草稿参数发送两轮工具测试并显示成功", async () => {
    mountForm();
    await wrapper.get('[data-testid="provider-tool-probe"]').trigger("click");
    await flushPromises();
    expect(h.invoke).toHaveBeenCalledWith(
      "llm_agent_probe",
      expect.objectContaining({ baseUrl: "https://gateway.example/openai", model: "custom", stream: false, extraBody: { top_p: 0.8 } }),
    );
    expect(wrapper.get('[data-testid="provider-tool-probe-result"]').text()).toContain("回填测试通过");
  });
  it("保留字段覆盖和请求头错误先在本地拦截", async () => {
    mountForm();
    await wrapper.setProps({ extraBodyText: '{"tools":[]}' });
    await wrapper.get('[data-testid="provider-tool-probe"]').trigger("click");
    expect(h.invoke).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain("tools");
    await wrapper.setProps({ extraBodyText: "{}", connectionError: "请求头格式错误" });
    await wrapper.get('[data-testid="provider-tool-probe"]').trigger("click");
    expect(wrapper.get('[data-testid="provider-tool-probe-result"]').text()).toContain("请求头格式错误");
  });
  it("工具不支持时显示宿主错误；修改草稿清除旧测试结果", async () => {
    h.invoke.mockRejectedValue(new Error("模型未返回测试工具调用"));
    mountForm();
    await wrapper.get('[data-testid="provider-tool-probe"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="provider-tool-probe-result"]').text()).toContain("未返回测试工具调用");
    await wrapper.setProps({ stream: true });
    expect(wrapper.find('[data-testid="provider-tool-probe-result"]').exists()).toBe(false);
  });
  it("请求途中改了模型，迟到的结果不会显示为新模型的测试成功", async () => {
    const gate = Promise.withResolvers<{ ok: boolean }>();
    h.invoke.mockReturnValue(gate.promise);
    mountForm();
    await wrapper.get('[data-testid="provider-tool-probe"]').trigger("click");
    await wrapper.setProps({ connection: { baseUrl: "https://gateway.example/openai", model: "other", apiKeyEnv: "" } });
    gate.resolve({ ok: true });
    await flushPromises();
    expect(wrapper.find('[data-testid="provider-tool-probe-result"]').exists()).toBe(false);
  });
});
