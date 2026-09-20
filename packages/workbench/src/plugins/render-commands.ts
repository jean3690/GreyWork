/**
 * 插件渲染指令集 v1：worker 渲染 handler 的返回值（纯 JSON），宿主白名单校验后
 * 画到 SVG 上。worker 保持零 DOM 访问 —— 渲染是数据交换，不是代码执行。
 *
 * 设计约束：
 * - 指令种类封闭（circle/ellipse/path/rect/text/group），未知 kind 整帧丢弃；
 * - 数值有界（坐标/尺寸 ≤ CANVAS_LIMIT，长度字符串 ≤ 64 字符），越界指令丢弃；
 * - 指令数有界（MAX_COMMANDS，含 group 子项展开），防一帧塞爆 DOM。
 */

export interface RenderStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export type RenderCommand =
  | ({ kind: "circle"; cx: number; cy: number; r: number } & RenderStyle)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & RenderStyle)
  | ({ kind: "rect"; x: number; y: number; w: number; h: number; rx?: number } & RenderStyle)
  | ({ kind: "path"; d: string } & RenderStyle)
  | ({ kind: "text"; x: number; y: number; text: string; fontSize?: number } & RenderStyle)
  | { kind: "group"; translate?: [number, number]; rotate?: number; scale?: number; children: RenderCommand[] };

export const RENDER_CANVAS_LIMIT = 512;
export const RENDER_MAX_COMMANDS = 256;
export const RENDER_MAX_TEXT_LENGTH = 64;
export const RENDER_MAX_PATH_LENGTH = 1024;
/** 颜色：#hex / rgb() / rgba() / 常用色名子集（防 url(...) 注入与外部引用）。 */
const RENDER_COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s,./%]+\)|[a-zA-Z]{3,20})$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 有界数值：NaN/±Infinity/超画布 2 倍（平移余量）视为非法。 */
function isBoundedNumber(value: unknown): value is number {
  return isFiniteNumber(value) && Math.abs(value) <= RENDER_CANVAS_LIMIT * 2;
}

function isValidColor(value: unknown): value is string {
  return typeof value === "string" && RENDER_COLOR_PATTERN.test(value);
}

function isValidStyle(style: Record<string, unknown>): boolean {
  if (style.fill !== undefined && !isValidColor(style.fill)) return false;
  if (style.stroke !== undefined && !isValidColor(style.stroke)) return false;
  if (style.strokeWidth !== undefined && (!isFiniteNumber(style.strokeWidth) || style.strokeWidth < 0 || style.strokeWidth > 64))
    return false;
  if (style.opacity !== undefined && (!isFiniteNumber(style.opacity) || style.opacity < 0 || style.opacity > 1)) return false;
  return true;
}

/**
 * 指令集校验（递归，计数展开后的总指令数）。
 * 返回 null = 整帧非法（宿主丢弃该帧，保留上一帧）；合法则原样返回。
 */
export function validateRenderCommands(value: unknown): RenderCommand[] | null {
  let budget = RENDER_MAX_COMMANDS;
  const visit = (node: unknown): RenderCommand | null => {
    if (budget <= 0) return null;
    if (typeof node !== "object" || node === null) return null;
    const command = node as Record<string, unknown>;
    switch (command.kind) {
      case "circle":
        if (!isBoundedNumber(command.cx) || !isBoundedNumber(command.cy) || !isBoundedNumber(command.r) || command.r < 0) return null;
        break;
      case "ellipse":
        if (
          !isBoundedNumber(command.cx) ||
          !isBoundedNumber(command.cy) ||
          !isBoundedNumber(command.rx) ||
          !isBoundedNumber(command.ry) ||
          command.rx < 0 ||
          command.ry < 0
        )
          return null;
        break;
      case "rect":
        if (
          !isBoundedNumber(command.x) ||
          !isBoundedNumber(command.y) ||
          !isBoundedNumber(command.w) ||
          !isBoundedNumber(command.h) ||
          command.w < 0 ||
          command.h < 0
        )
          return null;
        if (command.rx !== undefined && (!isFiniteNumber(command.rx) || command.rx < 0 || command.rx > RENDER_CANVAS_LIMIT)) return null;
        break;
      case "path":
        if (typeof command.d !== "string" || command.d.length === 0 || command.d.length > RENDER_MAX_PATH_LENGTH) return null;
        // SVG path 数据字符白名单：坐标/命令字符与分隔符，禁其他内容。
        if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-.,\s]+$/.test(command.d)) return null;
        break;
      case "text":
        if (typeof command.text !== "string" || command.text.length === 0 || command.text.length > RENDER_MAX_TEXT_LENGTH) return null;
        if (!isBoundedNumber(command.x) || !isBoundedNumber(command.y)) return null;
        if (command.fontSize !== undefined && (!isFiniteNumber(command.fontSize) || command.fontSize <= 0 || command.fontSize > 96))
          return null;
        break;
      case "group": {
        if (command.translate !== undefined) {
          const pair = command.translate;
          if (!Array.isArray(pair) || pair.length !== 2 || !isBoundedNumber(pair[0]) || !isBoundedNumber(pair[1])) return null;
        }
        if (command.rotate !== undefined && (!isFiniteNumber(command.rotate) || Math.abs(command.rotate) > 3600)) return null;
        if (command.scale !== undefined && (!isFiniteNumber(command.scale) || command.scale < 0.01 || command.scale > 16)) return null;
        if (!Array.isArray(command.children)) return null;
        budget -= 1;
        const children: RenderCommand[] = [];
        for (const child of command.children) {
          const validated = visit(child);
          if (!validated) return null;
          children.push(validated);
        }
        return {
          kind: "group",
          translate: Array.isArray(command.translate) ? [command.translate[0] as number, command.translate[1] as number] : undefined,
          rotate: command.rotate as number | undefined,
          scale: command.scale as number | undefined,
          children,
        };
      }
      default:
        return null;
    }
    if (!isValidStyle(command)) return null;
    budget -= 1;
    return command as unknown as RenderCommand;
  };

  if (!Array.isArray(value)) return null;
  const result: RenderCommand[] = [];
  for (const node of value) {
    const validated = visit(node);
    if (!validated) return null;
    result.push(validated);
  }
  return result;
}
