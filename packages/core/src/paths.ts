/**
 * 跨平台路径工具。
 *
 * 宿主（Rust）在 Windows 上 `canonicalize` 出来的路径带反斜杠，而渲染端原先各处
 * 各自手写 `/^[/\\]/` 判定与 `${a}/${b}` 拼接：
 * - 拼接会产出 `C:\ws/.agents/skills` 这种混合分隔符（宿主靠 `strip_prefix` 容错，
 *   所以只是观感问题，但看着像 bug）；
 * - 判定则真的会漏 —— 宿主剥掉 `\\?\` 前缀后返回的是 `C:\ws`，首字符不是分隔符。
 */

/** POSIX 绝对路径，或 Windows 的 `\\server\share` / `\\?\C:\`（verbatim）。 */
const LEADING_SEPARATOR = /^[/\\]/;
/** Windows 盘符绝对路径 `C:\` / `C:/`。 */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[/\\]/;
/** 任意一个分隔符（`/` 或 `\`）。 */
const ANY_SEPARATOR = /[/\\]/;
const TRAILING_SEPARATORS = /[/\\]+$/;
const LEADING_SEPARATORS = /^[/\\]+/;

/**
 * 是否绝对路径。
 *
 * 认：POSIX `/x`、Windows `C:\x` / `C:/x`、UNC `\\server\share`、verbatim `\\?\C:\x`。
 * 刻意**不认**盘符相对的 `C:foo`：它在 `join` 时会整段替换掉基准目录（宿主侧
 * `path_safety::is_safe_path_segment` 按同样规则拒绝），当成绝对路径会把它送进文件命令。
 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  return LEADING_SEPARATOR.test(path) || DRIVE_ABSOLUTE.test(path);
}

/**
 * 拼接路径段：沿用 `parent` 的分隔符，避免 Windows 上拼出 `C:\ws/child`。
 *
 * 空段被跳过；段的前导分隔符会被剥掉（`joinPath("/a", "/b")` → `/a/b`）。
 * 只做字符串拼接，不做 `..` 归一 —— 调用方拿到的都是宿主给的绝对路径。
 */
export function joinPath(parent: string, ...segments: string[]): string {
  const separator = ANY_SEPARATOR.test(parent) ? (parent.includes("\\") ? "\\" : "/") : "/";
  let out = parent;
  for (const raw of segments) {
    const segment = raw.replace(LEADING_SEPARATORS, "");
    if (!segment) continue;
    if (!out) out = segment;
    else if (TRAILING_SEPARATORS.test(out)) out = `${out}${segment}`;
    else out = `${out}${separator}${segment}`;
  }
  return out;
}

/**
 * 比较用的归一形式（`\` → `/`、去尾部斜杠）。
 *
 * **只用于比较，不回传宿主** —— 回传要保持宿主给的原样（含 Windows 的反斜杠）。
 * 刻意不折大小写：宿主每次给的都是同一套路径，折了反而会把 Linux 上仅大小写不同的
 * 两个真实目录合并成一个。
 */
export function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  // 根目录不能被归一成空串：调用方拿它做前缀匹配
  if (slashed === "/") return "/";
  return slashed.replace(TRAILING_SEPARATORS, "");
}
