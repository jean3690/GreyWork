// base.css 的层叠契约：表单控件兜底 reset 与全局焦点环**必须**待在 @layer base 里。
//
// 为什么值得单开一个测试守：本文件其余规则都是无层的，而无层样式永远压过 @layer 里的样式
// （与选择器特异度无关）。这两条一旦回到无层区，后果是静默的 —— 编译、类型、单测全绿，
// 只是全应用每个 <input> 的 `.border` / `.bg-*` / `.font-mono` / `disabled:cursor-not-allowed`
// 一起失效，`.outline-none` 也盖不住焦点环。纯靠人眼很难在 diff 里看出来。
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const CSS_PATH = fileURLToPath(new URL("../../../src/theme/base.css", import.meta.url));
// 注释里会引用这些选择器（「别把 input { … } 写回无层区」），先剥掉免得自证其罪。
const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 拆出所有 `@layer <name> { … }` 块（花括号配对），同时留下「无层」残余。 */
function splitLayers(source: string): { layers: Map<string, string>; unlayered: string } {
  const layers = new Map<string, string>();
  let unlayered = "";
  let cursor = 0;
  const opener = /@layer\s+([\w-]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let end = opener.lastIndex;
    while (end < source.length && depth > 0) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") depth -= 1;
      end += 1;
    }
    unlayered += source.slice(cursor, match.index);
    const name = match[1] ?? "";
    layers.set(name, (layers.get(name) ?? "") + source.slice(opener.lastIndex, end - 1));
    cursor = end;
    opener.lastIndex = end;
  }
  return { layers, unlayered: unlayered + source.slice(cursor) };
}

const { layers, unlayered } = splitLayers(css);
const base = layers.get("base") ?? "";

describe("base.css 的层叠契约", () => {
  it("表单控件兜底 reset 与全局焦点环都在 @layer base 里", () => {
    expect(base).not.toBe("");

    // 焦点环
    expect(base).toMatch(/button:focus-visible[\s\S]*textarea:focus-visible[\s\S]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    // input 兜底重置
    expect(base).toMatch(/input\s*\{[^}]*background:\s*transparent/);
    expect(base).toMatch(/input\s*\{[^}]*border:\s*none/);
    // 字族与光标兜底
    expect(base).toMatch(/font-family:\s*inherit/);
    expect(base).toMatch(/button\s*\{[^}]*cursor:\s*pointer/);
  });

  it("无层区不得再出现表单控件兜底 —— 无层样式会盖掉 @layer utilities 里的工具类", () => {
    // 无层 `input { border: none; background: transparent }` → 全应用输入框的
    // `.border` / `.border-line` / `.bg-panel-2` 一起失效，渲染成无边框透明块。
    expect(unlayered).not.toMatch(/\binput\s*\{/);
    // 无层 `button { cursor: pointer }` → `disabled:cursor-not-allowed` 失效。
    expect(unlayered).not.toMatch(/\bbutton\s*\{/);
    // 无层 `button, input { font-family: inherit }` → `.font-mono` 失效。
    expect(unlayered).not.toMatch(/font-family:\s*inherit/);
    // 无层焦点环 → `.outline-none` 失效，输入框点一下冒出直角蓝框。
    expect(unlayered).not.toMatch(/:focus-visible/);
  });
});
