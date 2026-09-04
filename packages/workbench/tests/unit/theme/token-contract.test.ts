// M6 Token 契约：THEME_TOKENS 与 theme/tokens.css 保持 parity（双向），
// 并强制 scope 语义（appearance-invariant 不得出现在 dark 块，scoped 必须覆盖）。
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { THEME_TOKENS, isThemeTokenKey } from "@/theme/token-contract";

const CSS_PATH = fileURLToPath(new URL("../../../src/theme/tokens.css", import.meta.url));
const css = readFileSync(CSS_PATH, "utf8");

/** 结构性布局变量：刻意不在主题契约内。 */
const STRUCTURAL = new Set(["--gw-sidebar-w", "--gw-rail-w", "--gw-topbar-h", "--gw-side-w", "--gw-statusbar-h"]);

/** 从一段 CSS 文本中提取所有自定义属性 key（含前导 --）。 */
function extractKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const match of source.matchAll(/(--[\w-]+)\s*:/g)) keys.add(match[1]);
  return keys;
}

const rootKeys = extractKeys(css);
const darkBlock = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
const darkKeys = darkBlock ? extractKeys(darkBlock[1]) : new Set<string>();

describe("THEME_TOKENS 契约（M6）", () => {
  it("非空且 key 唯一", () => {
    expect(THEME_TOKENS.length).toBeGreaterThan(0);
    const keys = THEME_TOKENS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("每个条目 key 以 -- 开头、描述非空", () => {
    for (const token of THEME_TOKENS) {
      expect(token.key.startsWith("--")).toBe(true);
      expect(token.description.length).toBeGreaterThan(0);
    }
  });

  it("isThemeTokenKey 对契约 key 返回 true", () => {
    for (const token of THEME_TOKENS) expect(isThemeTokenKey(token.key)).toBe(true);
  });

  it("isThemeTokenKey 拒绝未知 key 与结构布局变量", () => {
    expect(isThemeTokenKey("--nope")).toBe(false);
    expect(isThemeTokenKey("color-scheme")).toBe(false);
    for (const structural of STRUCTURAL) expect(isThemeTokenKey(structural)).toBe(false);
  });
});

describe("parity：契约 ↔ tokens.css（M6）", () => {
  it("契约内每个 key 都在 tokens.css 中定义（单向）", () => {
    for (const token of THEME_TOKENS) expect(rootKeys.has(token.key)).toBe(true);
  });

  it("tokens.css 中每个非结构变量都在契约内（反向，防漏登）", () => {
    for (const key of rootKeys) {
      if (STRUCTURAL.has(key)) continue;
      expect(isThemeTokenKey(key)).toBe(true);
    }
  });

  it("结构布局变量全部带 --gw- 前缀且未漏进契约", () => {
    for (const key of rootKeys) {
      if (!key.startsWith("--gw-")) continue;
      expect(STRUCTURAL.has(key)).toBe(true);
    }
  });
});

describe("scope 语义强制（M6）", () => {
  it("dark 块存在（有覆盖源可对照）", () => {
    expect(darkBlock).not.toBeNull();
    expect(darkKeys.size).toBeGreaterThan(0);
  });

  it("appearance-invariant 令牌不得出现在 dark 块", () => {
    for (const token of THEME_TOKENS) {
      if (token.scope !== "appearance-invariant") continue;
      expect(darkKeys.has(token.key)).toBe(false);
    }
  });

  it("appearance-scoped 令牌必须在 dark 块被覆盖", () => {
    for (const token of THEME_TOKENS) {
      if (token.scope !== "appearance-scoped") continue;
      expect(darkKeys.has(token.key)).toBe(true);
    }
  });
});
