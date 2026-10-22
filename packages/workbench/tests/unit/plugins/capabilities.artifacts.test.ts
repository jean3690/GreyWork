import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCapabilityLoader, type CapabilityLoader } from "@/plugins/loader";
import {
  capabilityAuditLog,
  resetCapabilityAuditForTest,
  setPluginArtifactPublisher,
  type PluginArtifactPublishRequest,
  type PluginArtifactPublisher,
} from "@/plugins/capabilities";
import type { PluginManifest } from "@/plugins/types";

/**
 * artifacts.publish 能力单测（node 环境，注入伪 publisher）：
 *  - 基本契约：返回 id / name / path / format，路径限定在 plugins/<id>/ 下
 *  - 文件名净化：路径分隔、控制字符、`..`、空白都不许逃出目录
 *  - 参数校验：空 name / 未知 format / 空 data / 超 256 KiB 不触达 publisher
 *  - 无 publisher → denied 审计；publisher 抛错 → error 审计 + 上抛
 *  - 滑动窗口限速（20 次 / 10 分钟，按插件隔离）
 *
 * 真实落盘走 stores/artifact 的 deliverArtifact（VFS + 默认目录 + artifact:created 广播），
 * 由 market.ts 在模块求值时注入。
 */

const storageHolder = globalThis as { localStorage?: Storage };

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

function memoryPublisher(): { publisher: PluginArtifactPublisher; calls: PluginArtifactPublishRequest[] } {
  const calls: PluginArtifactPublishRequest[] = [];
  const publisher: PluginArtifactPublisher = async (request) => {
    calls.push(request);
    if (request.data.includes("boom")) throw new Error("vfs write failed");
    return { id: `af-plugin-${calls.length}` };
  };
  return { publisher, calls };
}

let loader: CapabilityLoader;
let host: ReturnType<typeof memoryPublisher>;

function artifactsManifest(id = "demo.artifacts"): PluginManifest {
  return { id, name: "产物插件", version: "1.0.0", requires: ["artifacts.publish"] };
}

async function setupGranted(id = "demo.artifacts"): Promise<void> {
  loader.register(artifactsManifest(id));
  loader.grantCapability(id, "artifacts.publish");
  await loader.activate(id);
}

beforeEach(async () => {
  injectStorage();
  resetCapabilityAuditForTest();
  host = memoryPublisher();
  setPluginArtifactPublisher(host.publisher);
  loader = createCapabilityLoader();
  await setupGranted();
});

afterEach(() => {
  setPluginArtifactPublisher(null);
  resetCapabilityAuditForTest();
  delete storageHolder.localStorage;
});

describe("artifacts.publish 基本契约", () => {
  it("返回 id / name / path / format，路径落在 plugins/<id>/ 下", async () => {
    const result = (await loader.callCapability("demo.artifacts", "artifacts.publish", {
      name: "周报",
      format: "md",
      data: "# 周报",
    })) as { id: string; name: string; path: string; format: string };

    expect(result.id).toBe("af-plugin-1");
    expect(result.name).toBe("周报");
    expect(result.format).toBe("md");
    expect(result.path).toMatch(/^plugins\/demo\.artifacts\/\d+-周报\.md$/);
    expect(host.calls).toEqual([
      {
        pluginId: "demo.artifacts",
        name: "周报",
        path: result.path,
        format: "md",
        data: "# 周报",
      },
    ]);
  });

  it("审计记录成功调用（格式 / 字节数 / 路径）", async () => {
    await loader.callCapability("demo.artifacts", "artifacts.publish", {
      name: "chart",
      format: "html",
      data: "<p>hi</p>",
    });
    const entry = capabilityAuditLog().find((item) => item.capability === "artifacts.publish" && item.outcome === "ok");
    expect(entry?.detail).toMatch(/^html · 9 bytes · plugins\/demo\.artifacts\/\d+-chart\.html$/);
  });
});

describe("artifacts.publish 文件名净化", () => {
  it("路径分隔 / 连续点 / 空白都不许逃出 plugins/<id>/", async () => {
    const result = (await loader.callCapability("demo.artifacts", "artifacts.publish", {
      name: "../../etc/passwd",
      format: "md",
      data: "x",
    })) as { path: string; name: string };

    expect(result.path.startsWith("plugins/demo.artifacts/")).toBe(true);
    expect(result.path).not.toContain("..");
    expect(result.path).not.toContain("/etc/");
    expect(result.name).toBe("._._etc_passwd");

    const spaced = (await loader.callCapability("demo.artifacts", "artifacts.publish", {
      name: "my report 2026",
      format: "csv",
      data: "a,b",
    })) as { path: string };
    expect(spaced.path).toMatch(/\d+-my-report-2026\.csv$/);
  });

  it("纯空白名字按参数非法拒绝", async () => {
    await expect(loader.callCapability("demo.artifacts", "artifacts.publish", { name: "   ", format: "md", data: "x" })).rejects.toThrow(
      /requires/,
    );
  });
});

describe("artifacts.publish 参数校验", () => {
  it("拒绝未知 format / 空 data / 超 256 KiB，且不触达 publisher", async () => {
    await expect(loader.callCapability("demo.artifacts", "artifacts.publish", { name: "x", format: "exe", data: "x" })).rejects.toThrow(
      /requires/,
    );
    await expect(loader.callCapability("demo.artifacts", "artifacts.publish", { name: "x", format: "md", data: "" })).rejects.toThrow(
      /requires/,
    );
    await expect(
      loader.callCapability("demo.artifacts", "artifacts.publish", {
        name: "x",
        format: "md",
        data: "x".repeat(256 * 1024 + 1),
      }),
    ).rejects.toThrow(/requires/);
    expect(host.calls).toHaveLength(0);
  });
});

describe("artifacts.publish 宿主可用性与审计", () => {
  it("无 publisher 时调用失败并留 denied 审计", async () => {
    setPluginArtifactPublisher(null);
    await expect(loader.callCapability("demo.artifacts", "artifacts.publish", { name: "x", format: "md", data: "x" })).rejects.toThrow(
      /workbench shell/,
    );
    expect(capabilityAuditLog().some((entry) => entry.capability === "artifacts.publish" && entry.outcome === "denied")).toBe(true);
  });

  it("publisher 抛错 → error 审计 + 错误上抛", async () => {
    await expect(loader.callCapability("demo.artifacts", "artifacts.publish", { name: "x", format: "md", data: "boom" })).rejects.toThrow(
      /vfs write failed/,
    );
    expect(capabilityAuditLog().some((entry) => entry.capability === "artifacts.publish" && entry.outcome === "error")).toBe(true);
  });
});

describe("artifacts.publish 限速", () => {
  it("10 分钟窗口内第 21 次拒绝，且不触达 publisher", async () => {
    const guarded = createCapabilityLoader();
    guarded.register(artifactsManifest("demo.artifacts.burst"));
    guarded.grantCapability("demo.artifacts.burst", "artifacts.publish");
    await guarded.activate("demo.artifacts.burst");

    for (let index = 0; index < 20; index += 1) {
      await guarded.callCapability("demo.artifacts.burst", "artifacts.publish", {
        name: `doc-${index}`,
        format: "md",
        data: "x",
      });
    }
    const before = host.calls.length;
    await expect(
      guarded.callCapability("demo.artifacts.burst", "artifacts.publish", {
        name: "overflow",
        format: "md",
        data: "x",
      }),
    ).rejects.toThrow(/rate limit/);
    expect(host.calls).toHaveLength(before);
  });
});
