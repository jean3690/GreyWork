import { describe, expect, it } from "vitest";
import { RENDER_CANVAS_LIMIT, validateRenderCommands, type RenderCommand } from "@/plugins/render-commands";

/**
 * 渲染指令白名单：插件 worker 返回任意 JSON，validateRenderCommands 是安全边界。
 * 覆盖：合法指令放行、未知 kind / 越界数值 / 非法颜色 / 危险 path 字符 /
 * 超预算整帧丢弃 —— 任一非法即整帧 null（宿主保留上一帧）。
 */
describe("validateRenderCommands", () => {
  it("合法指令集放行：circle/ellipse/rect/path/text/group 混合", () => {
    const commands = [
      { kind: "circle", cx: 50, cy: 40, r: 20, fill: "#ff0000", opacity: 0.8 },
      { kind: "ellipse", cx: 50, cy: 40, rx: 10, ry: 5, stroke: "rgb(0,0,0)", strokeWidth: 2 },
      { kind: "rect", x: 0, y: 0, w: 100, h: 50, rx: 4 },
      { kind: "path", d: "M10 10 L20 20", fill: "tomato" },
      { kind: "text", x: 10, y: 20, text: "喵", fontSize: 16, fill: "#333" },
      { kind: "group", translate: [10, 10], rotate: 45, children: [{ kind: "circle", cx: 0, cy: 0, r: 5 }] },
    ];
    expect(validateRenderCommands(commands)).toEqual(commands);
  });

  it("未知 kind / 缺字段 / 越界数值 → 整帧 null", () => {
    expect(validateRenderCommands([{ kind: "iframe", src: "https://evil.com" }])).toBeNull();
    expect(validateRenderCommands([{ kind: "circle", cx: "x", cy: 1, r: 1 }])).toBeNull();
    expect(validateRenderCommands([{ kind: "circle", cx: 99999, cy: 1, r: 1 }])).toBeNull();
    expect(validateRenderCommands([{ kind: "rect", x: 0, y: 0, w: -5, h: 10 }])).toBeNull();
    expect(validateRenderCommands([{ kind: "path", d: "M0 0" }])).not.toBeNull();
    // 合法 path 通过（d 是唯一必需字段）。
  });

  it("危险内容拒绝：url() 颜色、危险 path 字符、超长文本/路径", () => {
    expect(validateRenderCommands([{ kind: "circle", cx: 1, cy: 1, r: 1, fill: "url(https://evil.com/x)" }])).toBeNull();
    expect(validateRenderCommands([{ kind: "circle", cx: 1, cy: 1, r: 1, fill: "javascript:alert(1)" }])).toBeNull();
    // path 字符白名单外（<script 之类）。
    expect(validateRenderCommands([{ kind: "path", d: "M0 0<svg onload=1>" }])).toBeNull();
    expect(validateRenderCommands([{ kind: "text", x: 1, y: 1, text: "x".repeat(65) }])).toBeNull();
    expect(validateRenderCommands([{ kind: "path", d: "M".repeat(1025) }])).toBeNull();
  });

  it("超预算整帧丢弃：展开子项计数超过上限", () => {
    const commands: RenderCommand[] = [];
    for (let index = 0; index < RENDER_CANVAS_LIMIT; index++) {
      commands.push({ kind: "circle", cx: 0, cy: 0, r: 1 });
    }
    expect(validateRenderCommands(commands)).toBeNull();
    // 恰好预算内：通过。
    const ok = commands.slice(0, 250);
    expect(validateRenderCommands(ok)).not.toBeNull();
  });

  it("非法嵌套（children 非数组 / group 缺 children / 无限深）→ null", () => {
    expect(validateRenderCommands([{ kind: "group", children: "nope" }])).toBeNull();
    expect(validateRenderCommands([{ kind: "group" }])).toBeNull();
    // 深递归有界：1000 层不炸栈（每层扣预算，很快归零返回 null）。
    let deep: unknown = { kind: "circle", cx: 1, cy: 1, r: 1 };
    for (let index = 0; index < 1000; index++) deep = { kind: "group", children: [deep] };
    expect(validateRenderCommands([deep])).toBeNull();
  });
});
