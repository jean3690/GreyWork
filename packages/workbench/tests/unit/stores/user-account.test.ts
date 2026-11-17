import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ControlPlaneAccount, ControlPlaneStatus } from "@/lib/control-plane";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@greywork/host-ipc", () => ({ hasHostCommands: () => true, invoke }));
import { useUserAccountStore } from "@/stores/user-account";

const idle: ControlPlaneStatus = {
  configured: false,
  source: null,
  baseUrl: null,
  email: null,
  registered: false,
  tickSecs: 30,
  lastHeartbeatAt: null,
  lastClaimAt: null,
  lastError: null,
  lastOutcome: null,
};
const linked: ControlPlaneAccount = {
  status: { ...idle, configured: true, source: "file", baseUrl: "http://localhost:8080", email: "u@grey.local", registered: true },
  session: {
    user: { id: "9223372036854775806", email: "u@grey.local", displayName: "Jean", role: "USER" },
    device: { id: 7, name: "pc", platform: "desktop" },
  },
  error: null,
};

beforeEach(() => {
  setActivePinia(createPinia());
  invoke.mockReset();
});

describe("user account", () => {
  it("去重并发刷新，只从宿主获取身份", async () => {
    invoke.mockResolvedValue(linked);
    const store = useUserAccountStore();
    await Promise.all([store.refresh(), store.refresh()]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(store.session?.user.id).toBe("9223372036854775806");
    expect(store.busy).toBe(false);
  });

  it("有配置但认证失效不算登录，显示 Java 返回的错误", async () => {
    invoke.mockResolvedValue({ ...linked, session: null, error: "登录态已失效" });
    const store = useUserAccountStore();
    await store.refresh();
    expect(store.status?.configured).toBe(true);
    expect(store.session).toBeNull();
    expect(store.error).toContain("失效");
  });

  it("入场码登录后刷新身份，退出后清空共享账号", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "control_plane_account") return linked;
      if (command === "control_plane_connect") return linked.status;
      return idle;
    });
    const store = useUserAccountStore();
    const input = { baseUrl: "http://localhost:8080", email: "u@grey.local", code: "ABC123" };
    expect(await store.login(input)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("control_plane_connect", input);
    expect(await store.logout()).toBe(true);
    expect(store.session).toBeNull();
    expect(store.status?.configured).toBe(false);
  });

  it("退出失败保留身份并展示错误", async () => {
    const store = useUserAccountStore();
    invoke.mockResolvedValue(linked);
    await store.refresh();
    invoke.mockRejectedValue(new Error("服务器不可达"));
    expect(await store.logout()).toBe(false);
    expect(store.session).toEqual(linked.session);
    expect(store.error).toContain("不可达");
    expect(store.busy).toBe(false);
  });

  it("晚到的刷新不能把退出后的账号恢复", async () => {
    let resolve: (value: ControlPlaneAccount) => void = () => {};
    invoke.mockImplementation((command: string) =>
      command === "control_plane_account"
        ? new Promise<ControlPlaneAccount>((done) => {
            resolve = done;
          })
        : Promise.resolve(idle),
    );
    const store = useUserAccountStore();
    const refresh = store.refresh();
    await store.logout();
    resolve(linked);
    await refresh;
    expect(store.session).toBeNull();
    expect(store.status?.configured).toBe(false);
  });

  it("控制面断开会同步清理账号，环境管理不发登录或退出命令", async () => {
    const store = useUserAccountStore();
    invoke.mockResolvedValue(linked);
    await store.refresh();
    store.acceptStatus(idle);
    expect(store.session).toBeNull();
    store.acceptStatus({ ...linked.status, source: "env" });
    invoke.mockClear();
    expect(await store.logout()).toBe(false);
    expect(await store.login({ baseUrl: "http://localhost:8080", email: "u@grey.local", code: "ABC" })).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
