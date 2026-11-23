import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { effectScope } from "vue";
import PreferencesSyncPane from "../PreferencesSyncPane.vue";
import { usePreferencesSync } from "../usePreferencesSync";
import { useUserAccountStore } from "@/stores/user-account";
import { useSettingsStore } from "@/stores/settings";
import { preferencesAccountKey } from "@/lib/preferences-sync";
import { i18n } from "@/i18n";

const host = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@greywork/host-ipc", async (importOriginal) => ({
  ...(await importOriginal()),
  hasHostCommands: () => true,
  invoke: host.invoke,
}));
const remotePrefs = { schemaVersion: 1, theme: "github", colorMode: "light", fontSize: "large", radius: "large", locale: "en-US" };
let cloud: { revision: string | null; deleted: boolean; payload: unknown };
const mounted: VueWrapper[] = [];
const scopes: ReturnType<typeof effectScope>[] = [];
function account(id = "1") {
  const store = useUserAccountStore();
  store.status = {
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
  };
  store.session = {
    user: { id, email: "test@example.local", displayName: null, role: "user" },
    device: { id: "device", name: "test", platform: "desktop" },
  };
}
beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  cloud = { revision: "9223372036854775806", deleted: false, payload: remotePrefs };
  host.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command !== "cloud_request") return null;
    const request = args as { method: string; body?: { baseRevision: string | null; payload: unknown } };
    if (request.method === "GET") return cloud;
    if (request.body?.baseRevision !== cloud.revision) throw new Error("PUT /api/sync/preferences 失败：HTTP 409 sync_conflict");
    cloud = { revision: "9223372036854775807", deleted: false, payload: request.body.payload };
    return { revision: cloud.revision };
  });
  account();
});
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount());
  scopes.splice(0).forEach((scope) => scope.stop());
});
async function render() {
  const view = mount(PreferencesSyncPane, { global: { plugins: [i18n] } });
  mounted.push(view);
  await flushPromises();
  return view;
}
function composable() {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(() => usePreferencesSync())!;
}

describe("多设备偏好同步", () => {
  it("读取不覆盖本机；确认拉取后只应用五项偏好，保留本机权限/路径/模型", async () => {
    const settings = useSettingsStore();
    settings.permissionTier = "read-only";
    settings.workspaceDir = "/my/workspace";
    const models = JSON.stringify(settings.modelProviders);
    const view = await render();
    expect(settings.theme).toBe("codex");
    await view.get('[data-testid="preferences-sync-use-cloud"]').trigger("click");
    await view.findComponent({ name: "ConfirmDialog" }).vm.$emit("confirm");
    await flushPromises();
    expect(settings.theme).toBe("github");
    expect(settings.locale).toBe("en-US");
    expect(settings.permissionTier).toBe("read-only");
    expect(settings.workspaceDir).toBe("/my/workspace");
    expect(JSON.stringify(settings.modelProviders)).toBe(models);
    const stored = JSON.parse(window.localStorage.getItem(preferencesAccountKey("https://java.test", "1")!)!);
    expect(stored.revision).toBe("9223372036854775806");
  });

  it("首次设备未建立基线时不能覆盖已有云端；冲突后显式确认可保留本机", async () => {
    const sync = composable();
    await sync.pushLocal();
    expect(sync.conflict.value).toBe(true);
    expect(useSettingsStore().theme).toBe("codex");
    expect(cloud.payload).toEqual(remotePrefs);
    await sync.keepLocal(sync.remote.value!, sync.fingerprint.value);
    expect(cloud.payload).toMatchObject({ theme: "codex" });
    expect(sync.baseline.value?.revision).toBe("9223372036854775807");
    expect(host.invoke).toHaveBeenCalledWith(
      "cloud_request",
      expect.objectContaining({ body: expect.objectContaining({ baseRevision: "9223372036854775806" }) }),
    );
  });

  it("确认后云端再次变化时不应用旧快照，本机操作期间变化也不被覆盖", async () => {
    const sync = composable();
    await sync.inspect();
    const expected = sync.remote.value!;
    const local = sync.fingerprint.value;
    cloud = { ...cloud, revision: "9223372036854775807" };
    await sync.useCloud(expected, local);
    expect(sync.error.value).toContain("云端又有更新");
    expect(useSettingsStore().theme).toBe("codex");
    useSettingsStore().setTheme("fox");
    await sync.useCloud(sync.remote.value!, local);
    expect(sync.error.value).toContain("本机偏好已变化");
    expect(useSettingsStore().theme).toBe("fox");
  });

  it("推送等待期间的本机新修改不被错误标为已同步，上传内容没有私密字段", async () => {
    cloud = { revision: null, deleted: false, payload: null };
    const sync = composable();
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const respond = host.invoke.getMockImplementation()!;
    host.invoke.mockImplementation(async (command, args) =>
      command === "cloud_request" && (args as { method: string }).method === "PUT" ? pending : respond(command, args),
    );
    const sending = sync.pushLocal();
    await flushPromises();
    useSettingsStore().setTheme("fox");
    finish({ revision: "9223372036854775806" });
    await sending;
    expect(sync.dirty.value).toBe(true);
    expect(sync.baseline.value?.payload.theme).toBe("codex");
    const put = host.invoke.mock.calls.find(([name, args]) => name === "cloud_request" && (args as { method: string }).method === "PUT")!;
    expect(Object.keys((put[1] as { body: { payload: object } }).body.payload).sort()).toEqual(
      ["schemaVersion", "theme", "colorMode", "fontSize", "radius", "locale"].sort(),
    );
  });

  it("换号会丢弃旧请求结果，不把旧版本写入新账号基线", async () => {
    const sync = composable();
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    host.invoke.mockImplementation(async (command) => (command === "cloud_request" ? pending : null));
    const reading = sync.inspect();
    await flushPromises();
    account("2");
    finish(cloud);
    await reading;
    expect(sync.remote.value).toBeNull();
    expect(sync.baseline.value).toBeNull();
    expect(window.localStorage.getItem(preferencesAccountKey("https://java.test", "2")!)).toBeNull();
  });

  it("删除标记和未来版本不会重置本机设置", async () => {
    const sync = composable();
    cloud = { revision: "9223372036854775806", deleted: true, payload: null };
    await sync.inspect();
    expect(sync.remote.value?.deleted).toBe(true);
    expect(useSettingsStore().theme).toBe("codex");
    cloud = { revision: "9223372036854775807", deleted: false, payload: { ...remotePrefs, schemaVersion: 2 } };
    await sync.inspect();
    expect(sync.error.value).toContain("版本不兼容");
    expect(useSettingsStore().theme).toBe("codex");
  });
});
