/**
 * 渲染指令集 v1：worker 的 render handler 返回纯 JSON，宿主白名单校验后画到 SVG 上。
 *
 * 指令种类封闭（circle / ellipse / rect / path / text / group），未知 kind 整帧丢弃；
 * 数值有界（坐标与尺寸 ≤ 512×2 的平移余量）、文本 ≤64 字符、单帧 ≤256 条指令。
 * 超界的指令不会「大致画出来」，而是被丢弃 —— 类型只能提示，边界由宿主强制。
 */

export interface RenderStyle {
  /** #hex / rgb() / rgba() / 常用色名；不接受 url(...) 等外部引用。 */
  fill?: string;
  stroke?: string;
  /** 0-64 */
  strokeWidth?: number;
  /** 0-1 */
  opacity?: number;
}

export type RenderCommand =
  | ({ kind: "circle"; cx: number; cy: number; r: number } & RenderStyle)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & RenderStyle)
  | ({ kind: "rect"; x: number; y: number; w: number; h: number; rx?: number } & RenderStyle)
  | ({ kind: "path"; d: string } & RenderStyle)
  | ({ kind: "text"; x: number; y: number; text: string; fontSize?: number } & RenderStyle)
  | {
      kind: "group";
      translate?: [number, number];
      /** 角度 */
      rotate?: number;
      scale?: number;
      children: RenderCommand[];
    };

/** render handler 的返回值：一帧指令数组。 */
export type RenderFrame = RenderCommand[];

/** 宿主侧边界常量（与 workbench render-commands.ts 一致）。 */
export const RENDER_LIMITS = {
  canvasLimit: 512,
  maxCommands: 256,
  maxTextLength: 64,
  maxPathLength: 1024,
} as const;
