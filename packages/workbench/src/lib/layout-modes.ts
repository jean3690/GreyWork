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

/**
 * 可见性 → 模式，供标题栏的布局指示器判断「当前是哪一档」。
 *
 * 四种组合都有名字，所以正常的组合总能推出来；返回 null 是给「将来加了面板、
 * 组合数超过命名数」留的出口 —— 那时指示器不点亮任何一档，而不是错点亮一档。
 */
export function modeOf(visibility: PanelVisibility): LayoutMode | null {
  for (const mode of LAYOUT_MODES) {
    const target = VISIBILITY[mode];
    if (target.sidebar === visibility.sidebar && target.preview === visibility.preview) return mode;
  }
  return null;
}

/**
 * 三槽位：指示器把每个模式画成「哪几个槽位在场」。
 *
 * 用槽位而不是文字名，是因为它直接编码了真实信息（面板在不在场），一眼可读、跨语言可读；
 * 四个模式恰好对应槽位的四种点亮组合，名称只作为 title / aria-label 存在。
 */
export interface SlotPresence {
  /** 左槽 = 左栏（会话列表 / 文件树）。 */
  left: boolean;
  /** 中槽 = 内容区，**恒为真** —— 它永远是布局的一部分，用来给另外两槽定坐标。 */
  center: boolean;
  /** 右槽 = 右栏预览面板。 */
  right: boolean;
}

export function slotsOf(mode: LayoutMode): SlotPresence {
  const visibility = VISIBILITY[mode];
  return { left: visibility.sidebar, center: true, right: visibility.preview };
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
