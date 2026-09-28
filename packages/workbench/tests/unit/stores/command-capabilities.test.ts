// 命令能力表：一次会话拉一次、in-flight 去重、unknown ≠ deny（available 回 null）。
// 非服务端态不发请求；HTTP 失败也标记 loaded（本轮不再重试，调用方按未知处理）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const hostIpc = vi.hoisted(() => ({
  runtimeMode: vi.fn<() => string>(() => "server"),
  loadCommandCatalog: vi.fn<() => Promise<unknown>>(async () => []),
}));

vi.mock("@greywork/host-ipc", () => ({
  runtimeMode: hostIpc.runtimeMode,
  loadCommandCatalog: hostIpc.loadCommandCatalog,
}));

import { useCommandCapabilitiesStore } from "@/stores/command-capabilities";

const CATALOG = [
  { name: "fs_list_dir", auth: "required", desktopOnly: false, binary: false, available: true },
  { name: "db_agents_sync", auth: "required", desktopOnly: false, binary: false, available: false },
  { name: "reveal_path", auth: "required", desktopOnly: true, binary: false, available: false },
];

beforeEach(() => {
  setActivePinia(createPinia());
  hostIpc.runtimeMode.mockReturnValue("server");
  hostIpc.loadCommandCatalog.mockReset().mockResolvedValue(CATALOG);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCommandCapabilitiesStore", () => {
  it("首用即拉：store 创建就发请求，available 如实回传", async () => {
    const store = useCommandCapabilitiesStore();
    await store.ensureCatalog();

    expect(hostIpc.loadCommandCatalog).toHaveBeenCalledTimes(1);
    expect(store.available("fs_list_dir")).toBe(true);
    expect(store.available("db_agents_sync")).toBe(false);
    expect(store.available("reveal_path")).toBe(false);
  });

  it("已加载后不重复拉取；并发开口走同一个 in-flight", async () => {
    // 挂起第一个请求，制造并发窗口。
    let release!: (value: unknown) => void;
    hostIpc.loadCommandCatalog.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));

    const store = useCommandCapabilitiesStore();
    const first = store.ensureCatalog();
    const second = store.ensureCatalog();
    expect(hostIpc.loadCommandCatalog).toHaveBeenCalledTimes(1);

    release(CATALOG);
    await Promise.all([first, second]);
    expect(hostIpc.loadCommandCatalog).toHaveBeenCalledTimes(1);
    expect(store.loaded).toBe(true);
  });

  it("未知命令回 null（unknown ≠ deny，语义交给调用方）", async () => {
    const store = useCommandCapabilitiesStore();
    expect(store.available("no_such_command")).toBeNull();

    await store.ensureCatalog();
    expect(store.available("no_such_command")).toBeNull();
  });

  it("目录拉取失败：同样标记 loaded，available 恒 null（fail-open）", async () => {
    hostIpc.loadCommandCatalog.mockResolvedValue(null);

    const store = useCommandCapabilitiesStore();
    await store.ensureCatalog();

    expect(store.loaded).toBe(true);
    expect(store.available("db_agents_sync")).toBeNull();
  });

  it("非服务端态：不发请求、立即返回，available 恒 null", async () => {
    hostIpc.runtimeMode.mockReturnValue("desktop");

    const store = useCommandCapabilitiesStore();
    await store.ensureCatalog();

    expect(hostIpc.loadCommandCatalog).not.toHaveBeenCalled();
    expect(store.available("fs_list_dir")).toBeNull();
  });
});
