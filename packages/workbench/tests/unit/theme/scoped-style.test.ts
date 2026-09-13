// 事故回归（2026-09-10）：AgentProviderIcon.vue 为了给 mono 品牌图标加反相，
// 在 scoped 块里写了 `:global(:root[data-theme="dark"]) .agent-provider-icon--mono`。
// Vue 的 scoped 编译器把这条规则降级成了 `:root[data-theme="dark"] { filter: invert(0.88) }`
// —— 等于深色模式下整页反相 88%：黑底翻成浅灰、蓝色主键变橙，
// 肉眼看到的「深色模式没有黑背景」就是这个。生产构建则会把这条规则整个丢掉（图标不反相）。
//
// 需要命中全局前缀（:root[data-theme]、html 等）时不要套 :global()：
// 直接写复合选择器，编译器会把作用域属性挂到最后一个类/元素上，前缀照旧生效。
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../../src", import.meta.url));

/** 收集 src 下所有 .vue（递归；忽略测试与类型目录之外的杂项）。 */
function vueFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...vueFiles(full));
    else if (entry.name.endsWith(".vue")) found.push(full);
  }
  return found;
}

describe("SFC scoped 样式不得用 :global()", () => {
  it("scoped 块内不出现 :global(（改用复合选择器）", () => {
    const offenders: string[] = [];
    for (const file of vueFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
        if (!/\bscoped\b/.test(match[1] ?? "")) continue;
        // 注释里为了说明事故会引用这段选择器，判据只看声明部分。
        const code = (match[2] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
        if (code.includes(":global(")) offenders.push(relative(SRC, file));
      }
    }
    expect(offenders, "scoped 块里的 :global() 会被编译器降级（前缀留在 :root 上、后代选择器丢失）。改为直接写复合选择器。").toEqual([]);
  });
});
