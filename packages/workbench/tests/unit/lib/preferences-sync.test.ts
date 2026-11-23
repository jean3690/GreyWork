import { describe, expect, it } from "vitest";
import {
  parsePreferencesSnapshot,
  parsePublicPreferences,
  parseSyncRevision,
  preferencesAccountKey,
  publicPreferencesOf,
} from "@/lib/preferences-sync";

const prefs = { schemaVersion: 1, theme: "codex", colorMode: "dark", fontSize: "medium", radius: "small", locale: "zh-CN" };
describe("跨设备偏好协议", () => {
  it("导出和导入只保留五项显示偏好，不带密钥、路径、权限或安装状态", () => {
    const unsafe = {
      ...prefs,
      permissionTier: "full",
      workspaceDir: "/private/work",
      apiKey: "secret",
      modelProviders: [{ headers: { Authorization: "secret" } }],
      mcpServers: [{ enabled: true }],
    };
    expect(parsePublicPreferences(unsafe)).toEqual(prefs);
    expect(publicPreferencesOf(unsafe as Parameters<typeof publicPreferencesOf>[0])).toEqual(prefs);
  });
  it("Long 保持字符串精度，拒绝数字版本和非法快照", () => {
    expect(parseSyncRevision("9223372036854775806")).toBe("9223372036854775806");
    expect(() => parseSyncRevision(Number("9223372036854775806"))).toThrow();
    expect(() => parseSyncRevision("9223372036854775808")).toThrow();
    expect(parsePreferencesSnapshot({ revision: null, deleted: false, payload: null }).payload).toBeNull();
    expect(() => parsePreferencesSnapshot({ revision: "1", deleted: false, payload: null })).toThrow();
    expect(() => parsePublicPreferences({ ...prefs, schemaVersion: 2 })).toThrow();
    expect(() => parsePublicPreferences({ ...prefs, theme: "constructor" })).toThrow();
  });
  it("同步基线按账号与服务器隔离，不把 URL 凭据或 token 查询参数落盘", () => {
    expect(preferencesAccountKey("https://java.test/", "1")).toBe(preferencesAccountKey("https://java.test", "1"));
    expect(preferencesAccountKey("https://java.test", "1")).not.toBe(preferencesAccountKey("https://java.test", "2"));
    expect(preferencesAccountKey("https://a.test", "1")).not.toBe(preferencesAccountKey("https://b.test", "1"));
    expect(preferencesAccountKey("https://user:password@java.test", "1")).toBeNull();
    expect(preferencesAccountKey("https://java.test?token=secret", "1")).toBeNull();
  });
});
