import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { DeviceItem, UserDetail, UserItem } from "../types";

const mock = vi.hoisted(() => ({
  users: vi.fn(),
  userDetail: vi.fn(),
  userDevices: vi.fn(),
  updateUser: vi.fn(),
  revokeSessions: vi.fn(),
  revokeDevice: vi.fn(),
  confirm: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../api", () => ({ adminApi: mock }));
vi.mock("element-plus", () => ({ ElMessageBox: { confirm: mock.confirm }, ElMessage: { success: mock.success, error: mock.error } }));
import { useUserManagement } from "./useUserManagement";

const userA: UserItem = {
  id: "9223372036854775805",
  email: "a@grey.local",
  displayName: "A",
  role: "user",
  status: "active",
  createdAt: "2026-11-18",
};
const userB: UserItem = { ...userA, id: "9223372036854775806", email: "b@grey.local", displayName: "B" };
const detailOf = (user: UserItem): UserDetail => ({ ...user, deviceCount: 1, lastActiveAt: null, providers: [] });
const device: DeviceItem = { id: "9223372036854775804", name: "phone", platform: "phone", lastSeenAt: null, createdAt: "2026-11-18" };
const wrappers: VueWrapper[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(): Promise<ReturnType<typeof useUserManagement>> {
  let state!: ReturnType<typeof useUserManagement>;
  wrappers.push(
    mount(
      defineComponent({
        setup() {
          state = useUserManagement();
          return () => h("div");
        },
      }),
    ),
  );
  await flushPromises();
  return state;
}

beforeEach(() => {
  for (const fn of Object.values(mock)) fn.mockReset();
  mock.users.mockResolvedValue([userA, userB]);
  mock.userDetail.mockImplementation(async (id: string) => detailOf(id === userA.id ? userA : userB));
  mock.userDevices.mockResolvedValue([device]);
  mock.confirm.mockResolvedValue("confirm");
  mock.revokeSessions.mockResolvedValue({ devices: 1 });
});
afterEach(() => {
  while (wrappers.length) wrappers.pop()?.unmount();
});

describe("用户管理", () => {
  it("较晚到达的旧搜索不会覆盖新的搜索结果或 loading 状态", async () => {
    const state = await setup();
    const old = deferred<UserItem[]>();
    const latest = deferred<UserItem[]>();
    mock.users.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    state.query.value = "old";
    const first = state.load();
    state.query.value = " new ";
    const second = state.load();
    old.resolve([userA]);
    await first;
    expect(state.loading.value).toBe(true);
    latest.resolve([userB]);
    await second;
    expect(state.rows.value).toEqual([userB]);
    expect(mock.users).toHaveBeenLastCalledWith("new", 100);
  });

  it("切换用户和关闭抽屉后不会回写旧详情", async () => {
    const state = await setup();
    const old = deferred<UserDetail>();
    mock.userDetail.mockReturnValueOnce(old.promise);
    const request = state.openDetail(userA);
    await state.openDetail(userB);
    old.resolve(detailOf(userA));
    await request;
    expect(state.detail.value?.id).toBe(userB.id);
    const late = deferred<UserDetail>();
    mock.userDetail.mockReturnValueOnce(late.promise);
    const closed = state.openDetail(userA);
    state.drawer.value = false;
    await nextTick();
    late.resolve(detailOf(userA));
    await closed;
    expect(state.detail.value).toBeNull();
    expect(state.detailLoading.value).toBe(false);
  });

  it("设备确认期间切换抽屉仍吊销原用户的设备", async () => {
    const state = await setup();
    await state.openDetail(userA);
    const confirmation = deferred<string>();
    mock.confirm.mockReturnValueOnce(confirmation.promise);
    const request = state.revokeDevice(device);
    await state.openDetail(userB);
    confirmation.resolve("confirm");
    await request;
    expect(mock.revokeDevice).toHaveBeenCalledWith(userA.id, device.id);
    expect(state.detail.value?.id).toBe(userB.id);
  });

  it("确认期间防止重复提交，取消后不调用更新接口", async () => {
    const state = await setup();
    const confirmation = deferred<string>();
    mock.confirm.mockReturnValueOnce(confirmation.promise);
    const first = state.toggleStatus(userA);
    await state.toggleStatus(userA);
    expect(mock.confirm).toHaveBeenCalledTimes(1);
    confirmation.resolve("confirm");
    await first;
    expect(mock.updateUser).toHaveBeenCalledTimes(1);
    expect(state.mutating.value).toBe(false);
    mock.confirm.mockRejectedValueOnce("cancel");
    await state.toggleRole(userA);
    expect(mock.updateUser).toHaveBeenCalledTimes(1);
  });

  it("变更角色后同步更新打开的用户详情", async () => {
    const state = await setup();
    await state.openDetail(userA);
    mock.userDetail.mockResolvedValue(detailOf({ ...userA, role: "admin" }));
    await state.toggleRole(userA);
    expect(mock.updateUser).toHaveBeenCalledWith(userA.id, { role: "admin" });
    expect(state.detail.value?.role).toBe("admin");
  });
});
