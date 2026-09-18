/**
 * unified diff（`.diff` / `.patch` 文件）行级解析。
 *
 * 为什么不用 `@codemirror/merge`：它的 `MergeView` / `unifiedMergeView` 要的是
 * 「原文 + 新文」**两份文档**，喂不进一份已经成型的 patch。它真正的用武之地是将来的
 * git 变更面板（左右对比工作区与基线），那不在本次范围内 —— 现在装它只会得到一个
 * 没有真实消费者的依赖。所以这里手写行级解析 + 着色，零依赖，与 `lib/markdown.ts`
 * 同一立场。
 *
 * 已知不支持：合并冲突标记、二进制 patch、`--git` 之外的 rename 元信息细节。
 * 这些在预览场景里只需要「原样显示为 meta 行」，不需要语义。
 */

export type DiffLineKind = "header" | "hunk" | "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 旧文件行号；新增行为 null。 */
  oldNo: number | null;
  /** 新文件行号；删除行为 null。 */
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

const GIT_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const META_PREFIXES = [
  "index ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "Binary files",
  "GIT binary patch",
  "\\ No newline at end of file",
];

function isMeta(line: string): boolean {
  return META_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * 按行拆分 patch / 文本，兼容 CRLF 与孤立 CR。
 *
 * Windows 上 `core.autocrlf=true` 的仓库、或 agent 直接读回来的 CRLF 文件，行尾会带
 * `\r`：只按 `\n` 切会让每个 `\r` 留在行内容里（渲染成方块），文件路径也会带上尾随
 * `\r`；两份原文差分时更糟 —— 一边 CRLF 一边 LF，逐行都判成改动，整篇都是红绿。
 */
function splitLinesCompat(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/**
 * 解析 unified diff。
 *
 * 分段优先认 `diff --git`；没有它（`diff -u` 直出的裸 patch）时退而用 `+++` 行起段，
 * 这样两种来源都能显示文件名而不是「未知文件」。
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  if (text.trim() === "") return [];

  const files: DiffFile[] = [];
  let oldNo = 0;
  let newNo = 0;

  /**
   * `---` 行先攒着：裸 patch（无 `diff --git`）里它排在 `+++` 之前，而路径要从 `+++`
   * 取。若让它直接开段，段就会以「未知文件」立住，后面的 `+++` 反而被当成 meta。
   */
  let pendingMeta: DiffLine[] = [];

  /**
   * 起一个新文件段。行号计数随之归零 —— hunk 头会立刻覆盖它们，这里只是防止
   * 上一个文件的行号漏进下一个段。
   */
  const openFile = (path: string, headerLine: string): DiffFile => {
    const file: DiffFile = { path, lines: [], added: 0, removed: 0 };
    if (headerLine !== "") file.lines.push({ kind: "header", text: headerLine, oldNo: null, newNo: null });
    file.lines.push(...pendingMeta);
    pendingMeta = [];
    files.push(file);
    oldNo = 0;
    newNo = 0;
    return file;
  };

  /** 当前段；patch 没有文件头就先开一个匿名段，宁可标「未知文件」也不丢内容。 */
  const tail = (): DiffFile => files[files.length - 1] ?? openFile("(未知文件)", "");

  for (const line of splitLinesCompat(text)) {
    const git = GIT_HEADER.exec(line);
    if (git) {
      openFile(git[2], line);
      continue;
    }

    // `---` / `+++` 必须在 add/del 判断之前拦下，否则文件头会被当成一整行删除+新增。
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim();
      // 没有 git 头（或上一段已经有 hunk）时用它起段；否则只作为 meta 行留档。
      const previous = files[files.length - 1];
      if (!previous || previous.lines.some((entry) => entry.kind === "hunk")) openFile(path, line);
      else previous.lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("--- ")) {
      const meta: DiffLine = { kind: "meta", text: line, oldNo: null, newNo: null };
      // 还没有任何段时攒着，等 `+++` 用真实路径开段后再落进去。
      if (files.length === 0) pendingMeta.push(meta);
      else tail().lines.push(meta);
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      const file = tail();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.lines.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
      continue;
    }

    if (isMeta(line)) {
      tail().lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
      continue;
    }

    if (line.startsWith("+")) {
      const file = tail();
      file.lines.push({ kind: "add", text: line.slice(1), oldNo: null, newNo });
      file.added += 1;
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      const file = tail();
      file.lines.push({ kind: "del", text: line.slice(1), oldNo, newNo: null });
      file.removed += 1;
      oldNo += 1;
      continue;
    }

    // 上下文行以单个空格起头；patch 工具偶尔省略它，所以空行也按上下文处理。
    if (line === "" || line.startsWith(" ")) {
      // split("\n") 会在末尾造出一个空串；还没开段就遇到空行说明是这种情况，跳过。
      if (line === "" && files.length === 0) continue;
      tail().lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }

    tail().lines.push({ kind: "meta", text: line, oldNo: null, newNo: null });
  }

  // 丢掉「只有一行头、既无 hunk 也无增删」的空段（例如末尾多余的 `+++` 行）。
  return files.filter((file) => file.lines.length > 1 || file.added > 0 || file.removed > 0);
}

/** 展平成一条行流（渲染时按文件分段，这个给「超大 patch 截断」计数用）。 */
export function countDiffLines(files: DiffFile[]): number {
  return files.reduce((total, file) => total + file.lines.length, 0);
}

/* ===== 两版文本的行级差分（工具调用的改动可视化） ===== */

export interface TextDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/**
 * 行级差分的内存护栏。
 *
 * LCS 是 O(n·m) 时间 + 空间。工具细节在写侧已按 MAX_DETAIL_CHARS（8k 字符）截断，
 * 正常只有几百行；但两条各 5000 行的输入会要 2500 万个 cell，足以让渲染线程卡死。
 * 超过阈值就退化成「整段删除 + 整段新增」——不好看，但绝不会把界面拖死。
 */
const MAX_DIFF_CELLS = 4_000_000;

/** 拆行：吃掉结尾换行，否则 `"a\n"` 会多出一条空行，差分出来凭空多一个改动。 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = splitLinesCompat(text);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 退化路径：不做对齐，旧文全删、新文全增。 */
function fallbackDiff(oldLines: string[], newLines: string[]): TextDiff {
  const lines: DiffLine[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const text of oldLines) lines.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
  for (const text of newLines) lines.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
  return { lines, added: newLines.length, removed: oldLines.length };
}

/**
 * 计算两版文本的行级差分（LCS 对齐），产出与 `parseUnifiedDiff` 同形的行流。
 *
 * `oldText === null` 表示整文件新建（没有旧版可比），此时每一行都是新增 —— 与
 * 工具调用语义里「write 未给 oldText」一致。空输入返回空结果。
 *
 * 与 `parseUnifiedDiff` 的分工：那个解析**已成型**的 patch 文本，这个对**两份原文**
 * 现算差分。工具调用只带 oldText/newText，没有 patch，所以必须走这条。
 */
export function diffTexts(oldText: string | null, newText: string): TextDiff {
  const oldLines = oldText === null ? [] : splitLines(oldText);
  const newLines = splitLines(newText);
  const removed = oldLines.length;
  const added = newLines.length;

  if (oldText === null) {
    // 整文件写入：没有旧版，全部按新增呈现（含行号，便于对照）。
    const lines: DiffLine[] = newLines.map((text, index) => ({ kind: "add" as const, text, oldNo: null, newNo: index + 1 }));
    return { lines, added, removed: 0 };
  }
  if (removed === 0 && added === 0) return { lines: [], added: 0, removed: 0 };
  if (removed * added > MAX_DIFF_CELLS) return fallbackDiff(oldLines, newLines);

  // LCS 长度表：table[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度。
  const table: number[][] = Array.from({ length: removed + 1 }, () => new Array<number>(added + 1).fill(0));
  for (let i = removed - 1; i >= 0; i -= 1) {
    for (let j = added - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < removed && j < added) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: "context", text: oldLines[i], oldNo: oldNo++, newNo: newNo++ });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "del", text: oldLines[i], oldNo: oldNo++, newNo: null });
      removedCount += 1;
      i += 1;
    } else {
      lines.push({ kind: "add", text: newLines[j], oldNo: null, newNo: newNo++ });
      addedCount += 1;
      j += 1;
    }
  }
  for (; i < removed; i += 1) {
    lines.push({ kind: "del", text: oldLines[i], oldNo: oldNo++, newNo: null });
    removedCount += 1;
  }
  for (; j < added; j += 1) {
    lines.push({ kind: "add", text: newLines[j], oldNo: null, newNo: newNo++ });
    addedCount += 1;
  }

  return { lines, added: addedCount, removed: removedCount };
}
