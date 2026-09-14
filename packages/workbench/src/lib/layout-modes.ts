/**
 * 布局模式：两个面板可见性的四种组合，每种给一个名字。
 *
 * **刻意做成「面板可见性的函数」而不是一份独立状态。** `Ctrl+B`（左栏）与 `Ctrl+\`（右栏）
 * 这两个既有开关本来就能组合出全部四种布局，再存一份模式状态只会多出一种坏状态 ——
 * 「模式显示三栏、实际只剩一个面板」。所以模式由可见性推导，快捷键只是把两个开关一起拨到位，
 * 省掉的那次按键而已。
 */

export type LayoutMode = "split" | "chat" | "document" | "focus";

export interface PanelVisibility {
  /** 左侧栏（会话列表 / 文件树）可见。 */
  sidebar: boolean;
  /** 右栏预览面板可见。 */
  preview: boolean;
}

/** 顺序即 `Ctrl+1..4` 的顺序：默认的三栏排第一。也是快捷键与可见性两张表的完整性锚点。 */
export const LAYOUT_MODES: readonly LayoutMode[] = ["split", "chat", "document", "focus"];

const VISIBILITY: Readonly<Record<LayoutMode, PanelVisibility>> = {
  /** 三栏：默认。会话 + 导航 + 预览同时在场。 */
  split: { sidebar: true, preview: true },
  /** 对话主导：留导航，收起预览，专心聊。 */
  chat: { sidebar: true, preview: false },
  /** 文档主导：收起导航，把宽度让给预览。 */
  document: { sidebar: false, preview: true },
  /** 专注：两个都收起，内容区拿满。 */
  focus: { sidebar: false, preview: false },
};

export function visibilityOf(mode: LayoutMode): PanelVisibility {
  return VISIBILITY[mode];
}

/** `Ctrl+1..4` 的物理键位。 */
const SHORTCUT_CODES: Readonly<Record<string, LayoutMode>> = {
  Digit1: "split",
  Digit2: "chat",
  Digit3: "document",
  Digit4: "focus",
};

/**
 * 把键位映射到模式；不是布局快捷键则返回 null。
 *
 * 按 **event.code** 而不是 `event.key`：数字键在 AZERTY 等布局上要按 Shift 才出数字，
 * `event.key` 会变成 `&` 之类的符号，快捷键在那些布局上直接失效。`code` 是物理键位，
 * 与键盘布局无关 —— 这也是同一个 handler 里字母键仍可用 `key` 的原因（字母位置稳定），
 * 但数字行不稳定。
 */
export function modeOfShortcut(code: string): LayoutMode | null {
  return SHORTCUT_CODES[code] ?? null;
}
