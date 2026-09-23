/**
 * 文件 / 文件夹名校验（新建与重命名共用）。纯字符串逻辑，便于单测。
 *
 * 规则与宿主 `path_safety::is_safe_path_segment` 对齐：渲染端先拦一次是为了**即时反馈**
 * （输入框下直接说哪里不对），宿主那一层才是安全边界（见 workspace_fs.rs 的
 * `resolve_new_entry`，它还会再兜一次）。
 *
 * 拒绝：
 * - 空（trim 之后）
 * - `.` / `..`
 * - 路径分隔符与 Windows 非法字符（`<>:"|?*`）及控制字符 —— 冒号还开 NTFS 数据流
 * - 结尾的 `.`：Win32 会静默剥掉，`foo.` 与 `foo` 落同一个文件
 * - Win32 保留设备名（`CON` / `NUL` / `COM1`…，带扩展名也算）
 *
 * 调用方应提交 `name.trim()` 的结果 —— 这里就是按 trim 之后判的。
 */
export type NameProblem = "empty" | "dot" | "illegal" | "trailing" | "reserved";

/** 首段（第一个 `.` 之前）是保留设备名即拒绝，`CON.txt` 也算（与宿主一致）。 */
const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;
/** 分隔符、Windows 非法字符、控制字符（含 NUL 与 DEL）。 */
// eslint-disable-next-line no-control-regex -- 控制字符正是要拦的东西之一
const ILLEGAL = /[<>:"|?*\\/\u0000-\u001f\u007f]/;

/** 名字有什么问题；`null` = 可用。 */
export function nameProblem(raw: string): NameProblem | null {
  const name = raw.trim();
  if (!name) return "empty";
  if (name === "." || name === "..") return "dot";
  if (ILLEGAL.test(name)) return "illegal";
  if (name.endsWith(".")) return "trailing";
  if (RESERVED_DEVICE.test(name)) return "reserved";
  return null;
}

/** 名字是否可用（新建 / 重命名提交按钮的判据）。 */
export function isUsableName(raw: string): boolean {
  return nameProblem(raw) === null;
}
