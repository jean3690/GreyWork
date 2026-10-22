/**
 * PATH 合并的纯逻辑（不依赖 Electron / node:child_process，便于跨平台单测）。
 *
 * 登录 shell 的 PATH 与进程继承的 PATH 都要保留：前者补上 GUI 会话常丢的
 * nvm / cargo / bun 目录，后者兜住用户在桌面会话里显式设置的目录。两边都可能
 * 含重复项，去重时保持**首次出现的位置**，否则 PATH 的优先级会被悄悄改掉。
 */

/** 按分隔符切分、去空、去重并保序。 */
export function mergePathEntries(entries: readonly string[], delimiter: string): string {
  const seen = new Set<string>();
  return entries
    .flatMap((entry) => entry.split(delimiter))
    .filter((dir) => {
      if (!dir || seen.has(dir)) return false;
      seen.add(dir);
      return true;
    })
    .join(delimiter);
}
