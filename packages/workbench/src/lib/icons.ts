/**
 * GreyWork 外壳图标：icon-park 风格的纯数据形状表（48 viewBox · outline 描边 · 圆头）。
 *
 * 为什么是「数据」而不是「组件」：形状表可被单测直接断言（名字齐全、形状非空），
 * 渲染只剩 Icon.vue 一层 v-for，免掉 render 函数里那堆 h() 噪音，也免新增图标依赖。
 */

export type IconShape =
  | { kind: "path"; d: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "circle"; cx: number; cy: number; r: number; filled?: boolean }
  | { kind: "rect"; x: number; y: number; w: number; h: number };

function p(d: string): IconShape {
  return { kind: "path", d };
}
function l(x1: number, y1: number, x2: number, y2: number): IconShape {
  return { kind: "line", x1, y1, x2, y2 };
}
function c(cx: number, cy: number, r: number, filled = false): IconShape {
  return { kind: "circle", cx, cy, r, filled };
}

/** 名称 → 形状序列。key 对标 GreyWork 用到的 @icon-park 图标名。 */
export const ICONS: Readonly<Record<string, readonly IconShape[]>> = {
  plus: [l(24, 9, 24, 39), l(9, 24, 39, 24)],
  search: [c(19, 19, 12), l(29, 29, 42, 42)],
  "arrow-left": [p("M42 24H6"), p("M17 13L6 24L17 35")],
  "arrow-right": [p("M6 24H42"), p("M31 13L42 24L31 35")],
  sidebar: [p("M6 12C6 9.2 8.2 7 11 7H37C39.8 7 42 9.2 42 12V36C42 38.8 39.8 41 37 41H11C8.2 41 6 38.8 6 36V12Z"), l(19, 7, 19, 41)],
  "expand-left": [p("M10 24H38"), p("M28 16L20 24L28 32")],
  "expand-right": [p("M38 24H10"), p("M20 16L28 24L20 32")],
  robot: [
    c(24, 6, 2, true),
    p("M24 8V12"),
    c(12, 18, 4),
    c(36, 18, 4),
    p("M12 22H36V32C36 36 35 40 32 40H16C13 40 12 36 12 32V22Z"),
    c(18, 28, 2, true),
    c(30, 28, 2, true),
  ],
  "alarm-clock": [
    p("M24 42C33 42 40 35 40 26V22C40 13 33 6 24 6C15 6 8 13 8 22V26C8 35 15 42 24 42Z"),
    l(20, 6, 18, 2),
    l(28, 6, 30, 2),
    p("M24 14V25L31 29"),
  ],
  peoples: [c(17, 15, 6), p("M7 40C7 31 11 25 17 25C23 25 27 31 27 40"), c(32, 17, 5), p("M30 27C35 27 41 33 41 40")],
  setting: [
    c(24, 24, 9),
    p("M24 4V10"),
    p("M24 38V44"),
    p("M4 24H10"),
    p("M38 24H44"),
    p("M10 10L14 14"),
    p("M34 34L38 38"),
    p("M38 10L34 14"),
    p("M14 34L10 38"),
  ],
  sun: [
    c(24, 24, 9),
    p("M24 4V8"),
    p("M24 40V44"),
    p("M4 24H8"),
    p("M40 24H44"),
    p("M10 10L13 13"),
    p("M35 35L38 38"),
    p("M38 10L35 13"),
    p("M13 35L10 38"),
  ],
  moon: [p("M38 30C31 36 20 35 15 27C10 19 13 9 22 6C21 11 22 17 27 22C31 26 35 28 38 30Z")],
  magic: [p("M14 8L18 16L26 20L18 24L14 32L10 24L2 20L10 16L14 8Z"), p("M36 26L38 31L43 33L38 35L36 40L34 35L29 33L34 31L36 26Z")],
  hammer: [p("M14 26L32 8L40 16L22 34"), p("M18 30L8 40L12 44L22 34"), l(35, 13, 39, 9)],
  message: [p("M8 8H40V32H24L14 40V32H8V8Z")],
  history: [c(24, 24, 17), p("M20 12V20L24 24"), p("M24 7C14 7 7 14 7 24")],
  delete: [p("M12 16H36L34 42H14L12 16Z"), l(8, 16, 40, 16), l(19, 8, 29, 8), l(21, 22, 21, 35), l(27, 22, 27, 35)],
  edit: [p("M26 8H12C10 8 8 10 8 12V38C8 40 10 42 12 42H38C40 42 42 40 42 38V26"), p("M33 6L42 15L24 33L17 35L19 28L33 6Z")],
  check: [p("M9 25L19 35L39 13")],
  close: [l(11, 11, 37, 37), l(37, 11, 11, 37)],
  down: [p("M14 20L24 30L34 20")],
  up: [p("M14 28L24 18L34 28")],
  right: [p("M18 14L28 24L18 34")],
  left: [p("M30 14L20 24L30 34")],
  "send-one": [p("M6 24L42 7L32 40L25 25L6 24Z")],
  lightning: [p("M26 5L12 27H21L20 43L36 18H26L29 5Z")],
  folder: [p("M7 13C7 11.3 8.3 10 10 10H19L23 16H38C39.7 16 41 17.3 41 19V35C41 36.7 39.7 38 38 38H10C8.3 38 7 36.7 7 35V13Z")],
  terminal: [p("M6 8H42V40H6V8Z"), p("M14 30L22 24L14 18"), l(28, 32, 36, 32)],
  earth: [c(24, 24, 18), l(6, 24, 42, 24), p("M24 6C31 13 31 35 24 42C17 35 17 13 24 6Z")],
  shield: [p("M24 5L39 11V23C39 33 32 39 24 43C16 39 9 33 9 23V11L24 5Z")],
  "check-one": [c(24, 24, 18), p("M16 25L22 31L33 20")],
  "close-one": [c(24, 24, 18), l(18, 18, 30, 30), l(30, 18, 18, 30)],
  refresh: [p("M40 24C40 33 33 40 24 40C15 40 8 33 8 24C8 18 11 12.7 16 10"), p("M16 4V10H22")],
  /** 默认工作区标记（图钉：圆头 + 针身）。 */
  pin: [c(24, 16, 8), l(24, 24, 24, 42)],
  more: [c(24, 9, 3, true), c(24, 24, 3, true), c(24, 39, 3, true)],
  minimize: [l(10, 24, 38, 24)],
  maximize: [{ kind: "rect", x: 12, y: 12, w: 24, h: 24 }],
  /** 向下还原：前方框 + 后方框露出的右上角，Windows 还原键的形状（与 maximize 同占 12–36 的方框）。 */
  restore: [{ kind: "rect", x: 12, y: 18, w: 18, h: 18 }, p("M18 18V12H36V30H30")],
};

/** 未登记的名称回落到 more（三点），避免渲染出空 svg 让布局塌陷。 */
export function getIconShapes(name: string): readonly IconShape[] {
  return ICONS[name] ?? ICONS.more;
}

/** 已登记的图标名（供单测枚举）。 */
export function iconNames(): string[] {
  return Object.keys(ICONS);
}
