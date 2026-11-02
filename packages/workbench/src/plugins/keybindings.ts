/**
 * 快捷键归一化：manifest 声明与键盘事件都归到同一串 canonical key。
 *
 * canonical 形态：修饰键按 `mod / ctrl / alt / shift` 顺序（子集、去重）+ 单个主键
 * （小写字母 / 数字 / F1-F12）。mod = macOS 的 Cmd、其它平台的 Ctrl；声明 `ctrl+x` 时
 * 两个平台的 Ctrl 都命中，声明 `mod+x` 时是 Cmd(mac) / Ctrl(其它)。
 *
 * 为什么要有这一层：Rust 安装期只校验形态，事件匹配（event.key 的大小写、F 键、
 * 平台修饰键差异）全在这里收口。
 */
export type PluginKeybindingKey = string;

const MODIFIER_ORDER = ["mod", "ctrl", "alt", "shift"] as const;

/** 平台探测在测试环境里不可靠（happy-dom 的 UA 串自带 Macintosh），测试可直接覆盖。 */
let platformOverride: "mac" | "other" | null = null;

export function setKeybindingPlatformForTest(next: "mac" | "other" | null): void {
  platformOverride = next;
}

function isMac(): boolean {
  if (platformOverride) return platformOverride === "mac";
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return /mac/i.test(`${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`);
}

/** 校验并归一化 manifest 里的 key；非法返回 null（安装期已校验，这里是防呆）。 */
export function normalizeKeybindingKey(key: string): string | null {
  const parts = key.trim().toLowerCase().split("+");
  if (parts.length < 1 || parts.length > MODIFIER_ORDER.length + 1) return null;
  const base = parts.pop() as string;
  const isLetterDigit = /^[a-z0-9]$/.test(base);
  const isFunctionKey = /^f([1-9]|1[0-2])$/.test(base);
  if (!isLetterDigit && !isFunctionKey) return null;
  // 裸主键只允许 F 功能键；字母 / 数字必须带修饰键（否则会打进输入框）。
  if (parts.length === 0) return isFunctionKey ? base : null;
  const mods: string[] = [];
  let last = 0;
  for (const modifier of parts) {
    const at = MODIFIER_ORDER.indexOf(modifier as (typeof MODIFIER_ORDER)[number]);
    if (at < 0 || at < last) return null;
    last = at + 1;
    mods.push(modifier);
  }
  // 无修饰键时只放行 F 功能键（字母 / 数字会打进输入框）。
  if (mods.length === 0) return /^f([1-9]|1[0-2])$/.test(base) ? base : null;
  if (!mods.some((modifier) => modifier !== "shift")) return null;
  return [...mods, base].join("+");
}

/** 把键盘事件归到 canonical key；不属于可匹配形态（没有主键修饰、非字母数字 F 键）返回 null。 */
export function eventBinding(event: KeyboardEvent): string | null {
  const base = event.key.toLowerCase();
  if (!(/^[a-z0-9]$/.test(base) || /^f([1-9]|1[0-2])$/.test(base))) return null;
  const mods: string[] = [];
  if (event.metaKey) mods.push("mod");
  else if (event.ctrlKey) mods.push(isMac() ? "ctrl" : "mod");
  if (event.altKey) mods.push("alt");
  if (event.shiftKey) mods.push("shift");
  // 无修饰键时只放行 F 功能键（字母 / 数字会打进输入框）。
  if (mods.length === 0) return /^f([1-9]|1[0-2])$/.test(base) ? base : null;
  if (!mods.some((modifier) => modifier !== "shift")) return null;
  return [...mods, base].join("+");
}
