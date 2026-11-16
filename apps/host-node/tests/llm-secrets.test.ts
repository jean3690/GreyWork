/**
 * 供应商密钥：按 baseUrl 存宿主数据目录（0600），命令只回掩码。
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSecret,
  moveSecret,
  configureSecretStore,
  listSecrets,
  maskSecret,
  normalizeBaseUrlKey,
  secretFor,
  secretStatus,
  setSecret,
} from "../src/llm-secrets.js";

const BASE = "https://api.example.test/v1";

function freshStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gw-llm-secrets-"));
  configureSecretStore(dir);
  return dir;
}

beforeEach(() => {
  freshStore();
});

describe("供应商密钥", () => {
  it("baseUrl 归一化：去空白与结尾斜杠", () => {
    expect(normalizeBaseUrlKey("  https://x.test/v1/  ")).toBe("https://x.test/v1");
    expect(normalizeBaseUrlKey(null)).toBe("");
  });

  it("掩码只露头尾，短 key 全遮", () => {
    expect(maskSecret("sk-proj-1234567890abcd")).toBe("sk-pro…abcd");
    expect(maskSecret("short")).toBe("****");
    expect(maskSecret("")).toBe("");
  });

  it("保存后可查状态与列表，清除后消失", () => {
    expect(secretStatus(BASE).saved).toBe(false);
    const { masked } = setSecret(BASE + "/", "sk-test-abcdefghij");
    expect(masked).toBe("sk-tes…ghij");
    expect(secretStatus(BASE)).toEqual({ saved: true, masked });
    expect(listSecrets()).toHaveLength(1);
    expect(secretFor(BASE)).toBe("sk-test-abcdefghij");

    expect(clearSecret(BASE)).toBe(true);
    expect(secretStatus(BASE).saved).toBe(false);
    expect(clearSecret(BASE)).toBe(false);
  });

  it("落盘 0600，且重新初始化后仍在（进程重启可用）", () => {
    const dir = freshStore();
    setSecret(BASE, "sk-persist-1234567890");
    const file = path.join(dir, "llm-secrets.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, { apiKey: string }>;
    expect(raw[BASE].apiKey).toBe("sk-persist-1234567890");

    configureSecretStore(dir); // 模拟重启：清缓存重读
    expect(secretFor(BASE)).toBe("sk-persist-1234567890");
  });

  it("改了 baseUrl 时密钥能迁过去（源写入目标、源删除）", () => {
    setSecret(BASE, "sk-move-1234567890");
    expect(moveSecret(BASE, "https://new.example.test/v1").moved).toBe(true);
    expect(secretFor(BASE)).toBeNull();
    expect(secretFor("https://new.example.test/v1")).toBe("sk-move-1234567890");
    // 源上没有密钥 / 地址相同：不动
    expect(moveSecret(BASE, "https://other.test/v1").moved).toBe(false);
    expect(moveSecret("https://new.example.test/v1/", "https://new.example.test/v1").moved).toBe(false);
  });

  it("缺 baseUrl / 空 key 拒绝写入", () => {
    expect(() => setSecret("   ", "sk-x")).toThrow(/baseUrl/);
    expect(() => setSecret(BASE, "  ")).toThrow(/不能为空/);
  });

  it("坏 JSON 当作没有密钥，不阻断模型调用", () => {
    const dir = freshStore();
    setSecret(BASE, "sk-broken-1234567890");
    // 直接写坏文件后重新加载
    writeFileSync(path.join(dir, "llm-secrets.json"), "{not json");
    configureSecretStore(dir);
    expect(secretFor(BASE)).toBeNull();
  });
});
