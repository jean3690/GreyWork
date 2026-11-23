import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { useSettingsStore } from "@/stores/settings";
import type { ControlPlaneAccount } from "@/lib/control-plane";
import JavaModelGatewayPane from "../JavaModelGatewayPane.vue";
import { validateModelConnection } from "@/lib/model-provider-config";

const host = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  hasHostCommands: () => true,
  invoke: host.invoke,
}));
const linked: ControlPlaneAccount = {
  status: {
    configured: true,
    source: "file",
    baseUrl: "https://java.test",
    email: "test@example.local",
    registered: true,
    tickSecs: 30,
    lastHeartbeatAt: null,
    lastClaimAt: null,
    lastError: null,
    lastOutcome: null,
  },
  session: {
    user: { id: "1", email: "test@example.local", displayName: null, role: "user" },
    device: { id: "2", name: "test", platform: "desktop" },
  },
  error: null,
};
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  host.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "control_plane_account") return linked;
    if (command === "cloud_request")
      return [
        { provider: "openai", labels: ["default"] },
        { provider: "qwen", labels: ["team"] },
      ];
    if (command === "llm_list_models") return ["test-model"];
    return null;
  });
});
afterEach(() => wrapper?.unmount());

async function render() {
  wrapper = mount(JavaModelGatewayPane);
  await flushPromises();
  return wrapper;
}
describe("Java 统一模型网关设置", () => {
  it("发现供应商与模型，选择后只保存逻辑来源，无需账号 token/本机 key", async () => {
    const view = await render();
    expect(view.text()).toContain("https://java.test");
    expect(host.invoke).toHaveBeenCalledWith("cloud_request", { method: "GET", path: "/api/llm/providers" });
    await view.get('[data-testid="java-gateway-models"]').trigger("click");
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith("llm_list_models", { baseUrl: "greywork://java/openai", apiKeyEnv: "", headers: {} });
    await view.get('[data-testid="java-gateway-use"]').trigger("click");
    const settings = useSettingsStore();
    expect(settings.selectedModelProviderId).toBe("java-openai");
    expect(settings.modelProviders.find((provider) => provider.id === "java-openai")).toMatchObject({
      id: "java-openai",
      name: "Java 网关 · openai",
      kind: "openai-compatible",
      baseUrl: "greywork://java/openai",
      model: "test-model",
      enabled: true,
      agentMode: false,
    });
    expect(validateModelConnection("greywork://java/openai", "test-model")).toBeNull();
    expect(validateModelConnection("greywork://java/evil", "test-model")).not.toBeNull();
  });

  it("上游不支持模型发现时仍可手动填写 ID，原有直连配置保留", async () => {
    const view = await render();
    const count = useSettingsStore().modelProviders.length;
    const respond = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) =>
      command === "llm_list_models" ? Promise.reject(new Error("HTTP 404")) : respond(command, args),
    );
    await view.get('[data-testid="java-gateway-models"]').trigger("click");
    await flushPromises();
    expect(view.get('[data-testid="java-gateway-error"]').text()).toContain("手动填写");
    await view.get('[data-testid="java-gateway-model"]').setValue("manual-model");
    await view.get('[data-testid="java-gateway-use"]').trigger("click");
    expect(useSettingsStore().modelProviders).toHaveLength(count + 1);
    expect(useSettingsStore().modelProviders[0].id).toBe("openai-compatible");
  });

  it("没有账号时显示接入提示，不请求供应商目录", async () => {
    host.invoke.mockImplementation(async (command) => (command === "control_plane_account" ? { ...linked, session: null } : null));
    const view = await render();
    expect(view.text()).toContain("请先在账号页面登录");
    expect(view.find('[data-testid="java-gateway-use"]').exists()).toBe(false);
    expect(host.invoke.mock.calls.some(([name]) => name === "cloud_request")).toBe(false);
  });

  it("供应商密钥仅一次写入 Java，成功后清空输入，客户端设置不持有密钥", async () => {
    const view = await render();
    await view.get('[data-testid="java-key-secret"]').setValue("test-upstream-key");
    await view.get('[data-testid="java-gateway-key-form"]').trigger("submit");
    await flushPromises();
    expect(host.invoke).toHaveBeenCalledWith("cloud_request", {
      method: "POST",
      path: "/api/llm/keys",
      body: { provider: "openai", label: "default", baseUrl: undefined, apiKey: "test-upstream-key" },
    });
    expect((view.get('[data-testid="java-key-secret"]').element as HTMLInputElement).value).toBe("");
    expect(JSON.stringify(useSettingsStore().modelProviders)).not.toContain("test-upstream-key");
    expect(window.localStorage.getItem("greywork.settings")).not.toContain("test-upstream-key");
  });

  it("再次选用同一网关保留用户兼容性设置，切换模型时重新关闭 Agent 模式", async () => {
    const view = await render();
    await view.get('[data-testid="java-gateway-model"]').setValue("first-model");
    await view.get('[data-testid="java-gateway-use"]').trigger("click");
    const settings = useSettingsStore();
    const saved = settings.modelProviders.find((provider) => provider.id === "java-openai")!;
    settings.upsertModelProvider({ ...saved, name: "我的网关", stream: false, temperature: 0.2, agentMode: true });
    await view.get('[data-testid="java-gateway-use"]').trigger("click");
    expect(settings.modelProviders.find((provider) => provider.id === "java-openai")).toMatchObject({
      name: "我的网关",
      stream: false,
      temperature: 0.2,
      agentMode: true,
    });
    await view.get('[data-testid="java-gateway-model"]').setValue("different-model");
    await view.get('[data-testid="java-gateway-use"]').trigger("click");
    expect(settings.modelProviders.find((provider) => provider.id === "java-openai")).toMatchObject({
      stream: false,
      temperature: 0.2,
      agentMode: false,
    });
  });
});
