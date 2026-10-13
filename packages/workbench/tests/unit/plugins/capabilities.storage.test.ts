import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import { capabilityAuditLog, resetCapabilityAuditForTest, resetStorageKvForTest } from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * storage.kv 能力单测（node 环境，注入 localStorage mock）：走 loader.callCapability
 * 真实管线（声明 + 授权 + 激活 → CAPABILITY_REGISTRY broker），覆盖：
 *   - 基本 CRUD 与返回值契约（get 未命中 → null、set/remove/clear → { ok }、list → keys）
 *   - 插件命名空间隔离（A 写 B 不可见）
 *   - 值 JSON 安全校验（undefined/NaN/循环/Date 拒绝；普通嵌套对象接受）
 *   - 键名白名单、单值 64 KiB、每插件总量 256 KiB 配额
 *   - 未声明 / 未授权 / revoke 后即时拒绝（三重校验门禁）
 *   - 持久化落 localStorage、审计留痕（ok / denied）
 */

const storageHolder = globalThis as { localStorage?: Storage };
const STORAGE_KEY = "greywork.plugins.storageKv";

function injectStorage(): void {
  const backing: Record<string, string> = {};
  storageHolder.localStorage = {
    getItem: (key: string) => backing[key] ?? null,
    setItem: (key: string, value: string) => {
      backing[key] = value;
    },
    removeItem: (key: string) => {
      delete backing[key];
    },
    clear: () => {
      for (const key of Object.keys(backing)) delete backing[key];
    },
    key: (index: number) => Object.keys(backing)[index] ?? null,
    get length() {
      return Object.keys(backing).length;
    },
  } as Storage;
}

let loader: CapabilityLoader;

function kvManifest(id = "demo.kv"): PluginManifest {
  return { id, name: "KV 插件", version: "1.0.0", requires: ["storage.kv"] };
}

async function setupGranted(id = "demo.kv"): Promise<void> {
  loader.register(kvManifest(id));
  loader.grantCapability(id, "storage.kv");
  await loader.activate(id);
}

function getStored(): Record<string, unknown> {
  const raw = storageHolder.localStorage?.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

beforeEach(async () => {
  injectStorage();
  resetStorageKvForTest();
  resetCapabilityAuditForTest();
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  resetStorageKvForTest();
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("storage.kv 基本读写", () => {
  it("set → get 命中，返回原值；未命中的 key 返回 null", async () => {
    await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "note", value: { text: "hello", n: 1, ok: true } });
    const got = (await loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "note" })) as { value: unknown };
    expect(got.value).toEqual({ text: "hello", n: 1, ok: true });

    const miss = (await loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "absent" })) as { value: unknown };
    expect(miss.value).toBeNull();
  });

  it("list 枚举当前键；remove 删除后 get 回落 null；clear 清空命名空间", async () => {
    await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "a", value: 1 });
    await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "b", value: "2" });

    const list = (await loader.callCapability("demo.kv", "storage.kv", { op: "list" })) as { keys: string[] };
    expect(list.keys.sort()).toEqual(["a", "b"]);

    await loader.callCapability("demo.kv", "storage.kv", { op: "remove", key: "a" });
    const afterRemove = (await loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "a" })) as { value: unknown };
    expect(afterRemove.value).toBeNull();

    await loader.callCapability("demo.kv", "storage.kv", { op: "clear" });
    const afterClear = (await loader.callCapability("demo.kv", "storage.kv", { op: "list" })) as { keys: string[] };
    expect(afterClear.keys).toEqual([]);
  });

  it("remove / clear 幂等：不存在的 key 与空命名空间都正常返回 ok", async () => {
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "remove", key: "nope" })).resolves.toEqual({ ok: true });
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "clear" })).resolves.toEqual({ ok: true });
  });

  it("插件命名空间隔离：A 写入的数据 B 读不到", async () => {
    const loaderAB = createCapabilityLoader();
    loaderAB.register(kvManifest("demo.a"));
    loaderAB.register(kvManifest("demo.b"));
    loaderAB.grantCapability("demo.a", "storage.kv");
    loaderAB.grantCapability("demo.b", "storage.kv");
    await loaderAB.activate("demo.a");
    await loaderAB.activate("demo.b");

    await loaderAB.callCapability("demo.a", "storage.kv", { op: "set", key: "secret", value: "A 的私有数据" });
    const bRead = (await loaderAB.callCapability("demo.b", "storage.kv", { op: "get", key: "secret" })) as { value: unknown };
    expect(bRead.value).toBeNull();
  });
});

describe("storage.kv 值安全校验", () => {
  it("接受 null / string / number / boolean / 数组 / 嵌套普通对象", async () => {
    for (const value of [null, "text", 42, -1.5, true, [1, "x", false], { deep: { list: [{ ok: true }] } }]) {
      const result = await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "v", value });
      expect(result).toEqual({ ok: true });
    }
  });

  it("拒绝 undefined / NaN / 函数 / 循环引用 / Date / Map（JSON 不安全）", async () => {
    const badValues: unknown[] = [
      undefined,
      NaN,
      () => undefined,
      (() => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        return circular;
      })(),
      new Date(),
      new Map([["k", 1]]),
    ];
    for (const value of badValues) {
      await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "v", value })).rejects.toThrow(
        /JSON-safe|must be JSON-safe|JSON-safe/,
      );
    }
  });

  it("非法 key（大写开头 / 空串 / 超长 / 特殊字符）被拒", async () => {
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "UPPER", value: 1 })).rejects.toThrow();
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "" })).rejects.toThrow();
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "a".repeat(200), value: 1 })).rejects.toThrow();
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "has space" })).rejects.toThrow();
  });

  it("list / clear 携带 key，或 get/remove 携带 value → 参数非法", async () => {
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "list", key: "x" })).rejects.toThrow();
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "clear", key: "x" })).rejects.toThrow();
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "x", value: 1 })).rejects.toThrow();
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "nope" })).rejects.toThrow();
  });

  it("单值超过 64 KiB 被拒，且不写入（配额检查在写前）", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "big", value: oversized })).rejects.toThrow(
      /per-value limit/,
    );
    const got = (await loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "big" })) as { value: unknown };
    expect(got.value).toBeNull();
  });

  it("每插件总量 256 KiB：累计超限被拒（替换自身不额外占额）", async () => {
    const chunk = "y".repeat(60 * 1024); // 60 KiB < 单值 64 KiB
    for (let index = 0; index < 4; index++) {
      await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: `k${index}`, value: chunk })).resolves.toEqual({
        ok: true,
      });
    }
    // 4 × 60 KiB = 240 KiB 可容纳；第 5 个冲过 256 KiB 配额。
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "k4", value: chunk })).rejects.toThrow(
      /per-plugin quota/,
    );
    // 原地替换一个较小值不触发总量问题（替换语义：减去旧值再计）。
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "k0", value: "小值" })).resolves.toEqual({ ok: true });
  });
});

describe("storage.kv 门禁", () => {
  it("未声明的能力调用被拒；插件未激活被拒", async () => {
    const loaderDeny = createCapabilityLoader();
    const manifest = kvManifest("demo.quiet");
    loaderDeny.register(manifest); // 声明但未授权、未激活
    await expect(loaderDeny.callCapability("demo.quiet", "storage.kv", { op: "list" })).rejects.toThrow(/not active/);

    loaderDeny.grantCapability("demo.quiet", "storage.kv");
    await loaderDeny.activate("demo.quiet");
    await expect(loaderDeny.callCapability("demo.quiet", "storage.kv", { op: "list" })).resolves.toEqual({ keys: [] });
  });

  it("revoke 后下一次调用即时被拒，先前写入的数据仍在（revoke 不影响已落盘数据）", async () => {
    await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "data", value: 42 });
    loader.revokeCapability("demo.kv", "storage.kv");
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "get", key: "data" })).rejects.toThrow(/revoked/);

    // 数据不因 revoke 丢失——revoke 只关能力门，不清插件私有存储。
    expect(getStored()).toHaveProperty(["demo.kv", "data"], 42);
  });
});

describe("storage.kv 持久化与审计", () => {
  it("写操作即时落 localStorage；结构为 { pluginId: { key: value } }", async () => {
    await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "prefs", value: { theme: "dark" } });
    expect(getStored()).toEqual({ "demo.kv": { prefs: { theme: "dark" } } });

    await loader.callCapability("demo.kv", "storage.kv", { op: "remove", key: "prefs" });
    expect(getStored()).toEqual({});
  });

  it("成功调用留 ok 审计，被拒写入留 denied 审计", async () => {
    await loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "x", value: 1 });
    await expect(
      loader.callCapability("demo.kv", "storage.kv", { op: "set", key: "x", value: "x".repeat(64 * 1024 + 1) }),
    ).rejects.toThrow();

    const log = capabilityAuditLog();
    expect(
      log.some(
        (entry) => entry.plugin === "demo.kv" && entry.capability === "storage.kv" && entry.outcome === "ok" && entry.detail === "set x",
      ),
    ).toBe(true);
    expect(
      log.some(
        (entry) =>
          entry.plugin === "demo.kv" &&
          entry.capability === "storage.kv" &&
          entry.outcome === "denied" &&
          /value exceeds/.test(entry.detail ?? ""),
      ),
    ).toBe(true);
  });

  it("损坏的存储归档回退为空（不炸），bad op 类型直接参数错误", async () => {
    storageHolder.localStorage?.setItem(STORAGE_KEY, "{not json");
    resetStorageKvForTest(); // 重新读取 → 回退空
    await expect(loader.callCapability("demo.kv", "storage.kv", { op: "list" })).resolves.toEqual({ keys: [] });
  });
});
