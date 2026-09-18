//! 路径段安全校验（Windows 优先）。
//!
//! 单段路径在 Windows 上有两类不靠 `..` 就能逃逸的写法，必须显式拒绝：
//!
//! 1. **盘符相对路径**：`C:evil` 有前缀无根，`base.join("C:evil")` 会**整段替换**基准
//!    目录，落到 `C:` 的当前目录下 —— 于是「往 `<root>/<id>` 写/删」变成往根外操作。
//!    同一个冒号还开 NTFS 数据流（`a.txt:hidden`）。因此冒号一律拒绝，不做「仅盘符
//!    前缀」的例外：会话 id、技能相对路径、插件 id 都不需要它。
//! 2. **保留设备名**：`CON` / `NUL` / `COM1` 之类在 Win32 层被解释成设备，带扩展名
//!    （`CON.txt`）也算；`foo.` / `foo ` 结尾会被静默剥掉，与 `foo` 撞名。
//!
//! 纯字符串逻辑，三个平台行为一致，测试在 Linux CI 上即可跑。

use std::path::{Component, Path, PathBuf};

/// 相对路径的最大层级（远端技能快照用，防止超深目录）。
const MAX_REL_DEPTH: usize = 16;
/// 会话 id 最大长度（与历史实现保持一致）。
const SESSION_ID_MAX_CHARS: usize = 128;

/// 单个路径段是否可安全地 `join` 到基准目录之下。
///
/// 拒绝：空 / `.` / `..` / 含 `/`、`\`、控制字符（含 NUL）、`<>"|?*`、`:` /
/// 以 `.` 或空格结尾 / 首段是保留设备名（大小写不敏感，带扩展名也算）。
pub fn is_safe_path_segment(segment: &str) -> bool {
    if segment.is_empty() || segment == "." || segment == ".." {
        return false;
    }
    // Windows 会静默剥掉结尾的 `.` 与空格，`foo.` 与 `foo` 落同一文件。
    if segment.ends_with('.') || segment.ends_with(' ') {
        return false;
    }
    // `is_control()` 覆盖 NUL 与 DEL/C1，不需要单独列 `\0`。
    if segment.chars().any(|ch| {
        ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | '"' | '|' | '?' | '*' | ':')
    }) {
        return false;
    }
    !is_reserved_device_name(segment)
}

/// 净化远端声明的相对路径：仅允许正斜杠分隔的非空普通段。
///
/// 拒绝绝对路径（前导 `/`、反斜杠、含冒号的盘符前缀）、`..`、超深层级，
/// 以及任何 `is_safe_path_segment` 不接受的段。
pub fn sanitize_rel_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.contains('\\') {
        return None;
    }
    let mut out = PathBuf::new();
    let mut depth = 0usize;
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        depth += 1;
        if depth > MAX_REL_DEPTH || !is_safe_path_segment(segment) {
            return None;
        }
        out.push(segment);
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// 会话 id 是否可安全用作 `attachments/<id>/` 的目录名。
///
/// 在 `is_safe_path_segment` 之上额外要求：非空、≤128 字符、不以 `.` 开头
/// （`.` 开头是宿主自己的元数据文件，不该被会话占用）。
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= SESSION_ID_MAX_CHARS
        && !id.starts_with('.')
        && is_safe_path_segment(id)
}

/// 是否是文件系统根（`/`、`C:\`、`\\server\share`、`\\?\C:\`）。
///
/// 统一三处各自为政的判定（工作区选择、会话 cwd、工作区根校验）。判定方式是「有
/// `RootDir` 组件、且没有任何普通组件」：
/// - POSIX 上 `parent()` 为 `None` 也能判 `/`，但 Windows 上 UNC 根
///   `\\server\share` 的 `parent()` **不是** `None`，只看 `parent()` 会漏；
/// - 盘符相对路径 `C:` 有 `Prefix` 但没有 `RootDir`，**不算**根（它会在 `join` 时
///   替换基准目录，由 `is_safe_path_segment` 那一层拦）。
pub fn is_filesystem_root(path: &Path) -> bool {
    let mut has_root = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => return false,
            Component::RootDir => has_root = true,
            Component::Prefix(_) | Component::CurDir | Component::ParentDir => {}
        }
    }
    has_root
}

/// 去掉 Windows `canonicalize` 加的 verbatim 前缀，其余原样保留（分隔符、大小写）。
///
/// `\\?\C:\ws\a` → `C:\ws\a`；`\\?\UNC\server\share\a` → `\\server\share\a`。
///
/// 只在**返回渲染端**时用：`\\?\` 是宿主内部做长度/语义处理的形态，UI 里显示成
/// 「会话存 \\?\C:\ws/.greyWork/sessions」既难看又会让前端的路径判定失效。
/// 内部比较不依赖这个函数 —— 那边走 `acp_host::comparable_path`，它会再抹平一次。
pub fn strip_verbatim_prefix(raw: &str) -> String {
    // UNC 形态要先判：`\\?\UNC\server\share` 剥完前缀是 `\\server\share`，
    // 直接删 `\\?\` 会留下一个假的 `UNC\` 目录名。
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    raw.strip_prefix(r"\\?\").unwrap_or(raw).to_string()
}

/// 首段（第一个 `.` 之前）是否是 Win32 保留设备名。
fn is_reserved_device_name(segment: &str) -> bool {
    let base = segment.split('.').next().unwrap_or(segment);
    let upper = base.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => match upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
        {
            Some(rest) => rest.len() == 1 && rest.as_bytes()[0].is_ascii_digit(),
            None => false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segment_rejects_windows_escapes() {
        // 正常名字
        assert!(is_safe_path_segment("SKILL.md"));
        assert!(is_safe_path_segment("ses-a"));
        assert!(is_safe_path_segment("a b"));
        assert!(is_safe_path_segment(".hidden"));

        // 盘符相对 / ADS
        assert!(!is_safe_path_segment("c:evil"));
        assert!(!is_safe_path_segment("C:"));
        assert!(!is_safe_path_segment("a.txt:hidden"));

        // 保留设备名（大小写不敏感，带扩展名也算）
        for name in ["CON", "con", "Con.txt", "NUL", "aux", "COM1", "lpt9", "PRN"] {
            assert!(!is_safe_path_segment(name), "{name:?} 应被拒绝");
        }
        // 不是保留名的近似写法要放行
        assert!(is_safe_path_segment("COM10"));
        assert!(is_safe_path_segment("COMx"));
        assert!(is_safe_path_segment("CONSOLE"));

        // 结尾的 `.` 与空格会被 Win32 静默剥掉
        assert!(!is_safe_path_segment("foo."));
        assert!(!is_safe_path_segment("foo "));

        // 分隔符、通配符、控制字符
        for bad in [
            "", ".", "..", "...", "a/b", "a\\b", "a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "a\nb",
            "a\0b",
        ] {
            assert!(!is_safe_path_segment(bad), "{bad:?} 应被拒绝");
        }
    }

    #[test]
    fn sanitize_rel_path_blocks_traversal_and_absolutes() {
        assert_eq!(
            sanitize_rel_path("SKILL.md"),
            Some(PathBuf::from("SKILL.md"))
        );
        assert_eq!(
            sanitize_rel_path("references/a.md"),
            Some(PathBuf::from("references").join("a.md"))
        );
        assert_eq!(sanitize_rel_path("../evil"), None);
        assert_eq!(sanitize_rel_path("/etc/passwd"), None);
        assert_eq!(sanitize_rel_path("a\\b.md"), None);
        assert_eq!(sanitize_rel_path(""), None);
        // 盘符前缀 / 保留设备名 / 结尾点空格
        assert_eq!(sanitize_rel_path("c:evil"), None);
        assert_eq!(sanitize_rel_path("a/c:evil"), None);
        assert_eq!(sanitize_rel_path("CON"), None);
        assert_eq!(sanitize_rel_path("sub/con.txt"), None);
        assert_eq!(sanitize_rel_path("foo."), None);
        // 结尾空格只在中间段可测（整串会被 trim 掉尾部空白）
        assert_eq!(sanitize_rel_path("foo /bar"), None);
        assert_eq!(sanitize_rel_path("a<b"), None);
        let deep = (0..20).map(|_| "x").collect::<Vec<_>>().join("/");
        assert_eq!(sanitize_rel_path(&deep), None);
    }

    #[test]
    fn session_id_rejects_drive_relative_and_reserved_names() {
        assert!(is_safe_session_id("ses-a"));
        assert!(is_safe_session_id("0d5b1f2e-aaaa"));

        assert!(!is_safe_session_id(""));
        assert!(!is_safe_session_id("C:evil"));
        assert!(!is_safe_session_id("c:"));
        assert!(!is_safe_session_id(".."));
        assert!(!is_safe_session_id(".hidden"));
        assert!(!is_safe_session_id("a/b"));
        assert!(!is_safe_session_id("a\\b"));
        assert!(!is_safe_session_id("CON"));
        assert!(!is_safe_session_id("foo."));
        assert!(!is_safe_session_id(&"x".repeat(SESSION_ID_MAX_CHARS + 1)));
        assert!(is_safe_session_id(&"x".repeat(SESSION_ID_MAX_CHARS)));
    }

    #[test]
    fn strip_verbatim_prefix_keeps_drive_and_unc_shapes() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\ws\a"), r"C:\ws\a");
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\ws\"), r"C:\ws\");
        // UNC：剥完应是 `\\server\share\a`，不是 `UNC\server\share\a`
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\a"),
            r"\\server\share\a"
        );
        // 已经不带前缀的原样返回（POSIX、普通盘符路径、普通 UNC）
        assert_eq!(strip_verbatim_prefix("/home/u/a"), "/home/u/a");
        assert_eq!(strip_verbatim_prefix(r"C:\ws\a"), r"C:\ws\a");
        assert_eq!(strip_verbatim_prefix(r"\\server\share"), r"\\server\share");
        assert_eq!(strip_verbatim_prefix(""), "");
    }

    /// 所有平台都成立的根判定。
    #[test]
    fn filesystem_root_detection_covers_posix_roots() {
        assert!(is_filesystem_root(Path::new("/")));
        assert!(!is_filesystem_root(Path::new("/home")));
        assert!(!is_filesystem_root(Path::new("relative")));
        assert!(!is_filesystem_root(Path::new("")));
        assert!(!is_filesystem_root(Path::new("..")));
    }

    /// Windows 的 `C:\` / UNC 根只有在 Windows 上才会被解析成 `Prefix + RootDir`；
    /// 在 Linux 上 `C:\` 只是一个普通文件名，所以这条只能按平台跑。
    #[cfg(windows)]
    #[test]
    fn filesystem_root_detection_covers_windows_roots() {
        assert!(is_filesystem_root(Path::new(r"C:\")));
        assert!(is_filesystem_root(Path::new("C:/")));
        // UNC 根：`parent()` 不是 None，只看 parent() 的旧实现会漏掉
        assert!(is_filesystem_root(Path::new(r"\\server\share")));
        assert!(is_filesystem_root(Path::new(r"\\?\C:\")));

        assert!(!is_filesystem_root(Path::new(r"C:\ws")));
        assert!(!is_filesystem_root(Path::new(r"\\server\share\ws")));
        // 盘符相对路径有 Prefix 但没有 RootDir，不算根
        assert!(!is_filesystem_root(Path::new("C:")));
        assert!(!is_filesystem_root(Path::new("C:evil")));
    }
}
