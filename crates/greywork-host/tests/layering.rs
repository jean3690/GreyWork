//! 分层守卫：`core` ← `infra` ← `services` ← `channels` ← `app`，层间依赖只准**下行**。
//!
//! 背景：`greywork-host` 按五层目录组织（见 `src/lib.rs` 的模块文档），但 Rust 的模块隐私
//! 拦不住同 crate 内的跨层引用 —— `mod infra;` 在 crate 内处处可见。这个集成测试在**源码
//! 文本层面**兜底：任何生产代码里 `crate::<name>` 若指向比自身更高的层，即判失败。
//!
//! 两条豁免：
//! - **测试文件**（`tests.rs` 与 `tests/` 目录下的文件）整文件跳过 —— 集成式单测本就允许
//!   跨层装配（如 `infra/db/tests.rs` 直接驱动 `services::host_exec`）。
//! - **内联 `#[cfg(test)]` 项**被剔除 —— 它们同样是测试代码。
//!
//! 覆盖面：`crate::` 后既可能是层目录名（`crate::services::llm`），也可能是 facade 叶子名
//! （`crate::llm`、`crate::host_exec`）。两者都靠解析 `lib.rs` 的 `pub use` 映射回层号，
//! 所以 facult 短名同样会被抓到。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// 层名，索引即层号（越大越高）。
const LAYERS: &[&str] = &["core", "infra", "services", "channels", "app"];

fn layer_of(name: &str) -> Option<usize> {
    LAYERS.iter().position(|l| *l == name)
}

fn src_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// facade 名 → 层号：五个层目录名本身，加上 `lib.rs` 里 `pub use <layer>::…` 导出的每个叶子
/// （含 `common as channel_common` 这类 `as` 别名）。
fn facade_layers() -> BTreeMap<String, usize> {
    let mut map: BTreeMap<String, usize> = BTreeMap::new();
    for (i, l) in LAYERS.iter().enumerate() {
        map.insert((*l).to_string(), i);
    }

    let lib = fs::read_to_string(src_root().join("lib.rs")).expect("读 lib.rs");
    let mut rest = lib.as_str();
    while let Some(pos) = rest.find("pub use ") {
        rest = &rest[pos + "pub use ".len()..];

        // 层名
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let lname = &rest[..end];
        rest = &rest[end..];
        let Some(layer) = layer_of(lname) else {
            continue;
        };

        // 期望 `::`
        let Some(after_colons) = rest.trim_start().strip_prefix("::") else {
            continue;
        };
        let after_colons = after_colons.trim_start();

        if let Some(inner_and_rest) = after_colons.strip_prefix('{') {
            // 组导入：`pub use layer::{ a, b as c, … };`
            let close = inner_and_rest.find('}').unwrap_or(inner_and_rest.len());
            let inner = &inner_and_rest[..close];
            rest = &inner_and_rest[(close + 1).min(inner_and_rest.len())..];
            for tok in inner.split(',') {
                let tok = tok.trim();
                if tok.is_empty() {
                    continue;
                }
                if let Some((orig, alias)) = tok.split_once(" as ") {
                    map.insert(orig.trim().to_string(), layer);
                    map.insert(alias.trim().to_string(), layer);
                } else {
                    map.insert(tok.to_string(), layer);
                }
            }
        } else {
            // 单个：`pub use layer::leaf;`
            let semi = after_colons.find(';').unwrap_or(after_colons.len());
            let leaf = after_colons[..semi].trim();
            rest = &after_colons[(semi + 1).min(after_colons.len())..];
            if !leaf.is_empty() {
                map.insert(leaf.to_string(), layer);
            }
        }
    }
    map
}

/// 把注释与字符串字面量**内容**替换成空格（保留换行与其余字节），使后续能安全地按字节配花括号、
/// 并避免注释里的 `crate::…` 造成误报。返回值与原串字节等长且仍是合法 UTF-8。
fn blank_noncode(src: &str) -> Vec<u8> {
    let b = src.as_bytes();
    let mut out = src.as_bytes().to_vec();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            // 行注释：清到行尾（不含换行）
            out[i] = b' ';
            out[i + 1] = b' ';
            i += 2;
            while i < b.len() && b[i] != b'\n' {
                out[i] = b' ';
                i += 1;
            }
        } else if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            // 块注释（Rust 可嵌套）
            let mut depth = 1usize;
            out[i] = b' ';
            out[i + 1] = b' ';
            i += 2;
            while i < b.len() && depth > 0 {
                if b[i] == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
                    depth += 1;
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                } else if b[i] == b'*' && i + 1 < b.len() && b[i + 1] == b'/' {
                    depth -= 1;
                    out[i] = b' ';
                    out[i + 1] = b' ';
                    i += 2;
                } else {
                    out[i] = if b[i] == b'\n' { b'\n' } else { b' ' };
                    i += 1;
                }
            }
        } else if c == b'r' || c == b'b' {
            if let Some(end) = raw_string_end(b, i) {
                blank_span(&mut out, b, i, end, true);
                i = end;
            } else {
                i += 1;
            }
        } else if c == b'"' {
            let end = normal_string_end(b, i);
            blank_span(&mut out, b, i, end, true);
            i = end;
        } else if c == b'\'' {
            if let Some(end) = char_literal_end(b, i) {
                blank_span(&mut out, b, i, end, false);
                i = end;
            } else {
                // 生命周期（`'a`）等，按普通字节处理
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    out
}

/// 把 `out[start..end]` 覆写成空格（`keep_newlines` 时保留换行），用于清空注释/字面量内容。
fn blank_span(out: &mut [u8], src: &[u8], start: usize, end: usize, keep_newlines: bool) {
    for (slot, &orig) in out[start..end].iter_mut().zip(&src[start..end]) {
        *slot = if keep_newlines && orig == b'\n' {
            b'\n'
        } else {
            b' '
        };
    }
}

/// `r"…"` / `r#"…"#` / `br#"…"#` / `b"…"` 等原始字节串的结束下标（不含边界时返回 `None`）。
fn raw_string_end(b: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    if b[i] == b'b' {
        i += 1;
    }
    if i >= b.len() || b[i] != b'r' {
        return None;
    }
    i += 1;
    let mut hashes = 0usize;
    while i < b.len() && b[i] == b'#' {
        hashes += 1;
        i += 1;
    }
    if i >= b.len() || b[i] != b'"' {
        return None;
    }
    i += 1;
    while i < b.len() {
        if b[i] == b'"' {
            let closed = (0..hashes).all(|k| i + 1 + k < b.len() && b[i + 1 + k] == b'#');
            if closed {
                return Some(i + 1 + hashes);
            }
        }
        i += 1;
    }
    Some(b.len())
}

/// 普通字符串 `"…"` 的结束下标（收尾引号之后）。
fn normal_string_end(b: &[u8], start: usize) -> usize {
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    b.len()
}

/// `'x'` / `'\n'` / `'\u{1F600}'` 的结束下标；生命周期（`'a`）返回 `None`。
fn char_literal_end(b: &[u8], start: usize) -> Option<usize> {
    if start + 1 >= b.len() {
        return None;
    }
    if b[start + 1] == b'\\' {
        let mut i = start + 2;
        while i < b.len() {
            match b[i] {
                b'\'' => return Some(i + 1),
                b'\n' => return None,
                _ => i += 1,
            }
        }
        None
    } else if start + 2 < b.len() && b[start + 2] == b'\'' {
        Some(start + 3)
    } else {
        None
    }
}

/// 把内联 `#[cfg(test)]` 项清空（保留换行以稳住行号）。必须在 [`blank_noncode`] 之后调用 ——
/// 此时字符串/注释已清空，按字节配花括号才安全。
fn blank_tests(mut s: String) -> String {
    const NEEDLE: &str = "#[cfg(test)]";
    while let Some(pos) = s.find(NEEDLE) {
        let bytes = s.as_bytes();
        let mut j = pos + NEEDLE.len();
        // 跳过空白与后续属性，定位到项起点
        loop {
            while j < bytes.len() && (bytes[j] as char).is_whitespace() {
                j += 1;
            }
            if j + 1 < bytes.len() && bytes[j] == b'#' && bytes[j + 1] == b'[' {
                let mut k = j + 1;
                while k < bytes.len() && bytes[k] != b']' {
                    k += 1;
                }
                j = (k + 1).min(bytes.len());
                continue;
            }
            break;
        }
        let end = if j < bytes.len() && bytes[j] == b'{' {
            match_brace(&s, j)
        } else {
            match s[j..].find(';') {
                Some(rel) => j + rel + 1,
                None => s.len(),
            }
        };
        let blanked: String = s[pos..end]
            .chars()
            .map(|c| if c == '\n' { '\n' } else { ' ' })
            .collect();
        s.replace_range(pos..end, &blanked);
    }
    s
}

/// `s[j]` 为 `{`，返回配对 `}` 之后的下标（前提：字符串/注释已清空）。
fn match_brace(s: &str, j: usize) -> usize {
    let b = s.as_bytes();
    let mut depth = 0i32;
    let mut i = j;
    while i < b.len() {
        match b[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    b.len()
}

/// 收集 `crate::<name>` 引用（含 `crate::{a, b::c}` 组），返回 `(行号, 名字)`。
fn crate_refs(src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = src[from..].find("crate::") {
        let abs = from + rel;
        let line = src[..abs].bytes().filter(|b| *b == b'\n').count() + 1;
        let after = &src[abs + "crate::".len()..];
        if let Some(rest) = after.strip_prefix('{') {
            if let Some(close) = rest.find('}') {
                for tok in rest[..close].split(',') {
                    if let Some(name) = path_head(tok) {
                        out.push((line, name));
                    }
                }
            }
        } else if let Some(name) = path_head(after) {
            out.push((line, name));
        }
        from = abs + "crate::".len();
    }
    out
}

/// 取路径首段标识符（`db::Db` → `db`）。
fn path_head(s: &str) -> Option<String> {
    let s = s.trim_start();
    let end = s
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(s.len());
    (end > 0).then(|| s[..end].to_string())
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// 文件所属层号（首段目录名）；`src/` 直下的文件（如 `lib.rs`）不参与。
fn file_layer(path: &Path) -> Option<usize> {
    let rel = path.strip_prefix(src_root()).ok()?;
    let first = rel.components().next()?;
    layer_of(&first.as_os_str().to_string_lossy())
}

/// 整文件测试豁免：`tests.rs` 或位于 `tests/` 目录下。
fn is_test_file(path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(src_root()) else {
        return false;
    };
    if rel.file_name().is_some_and(|n| n == "tests.rs") {
        return true;
    }
    rel.components().any(|c| c.as_os_str() == "tests")
}

#[test]
fn layers_only_depend_downward() {
    let facade = facade_layers();
    let mut files = Vec::new();
    collect_rs_files(&src_root(), &mut files);

    let mut violations = Vec::new();
    for path in &files {
        let Some(own) = file_layer(path) else {
            continue;
        };
        if is_test_file(path) {
            continue;
        }
        let raw = fs::read_to_string(path).expect("读取源文件");
        let blanked = blank_tests(String::from_utf8(blank_noncode(&raw)).expect("UTF-8"));
        for (line, name) in crate_refs(&blanked) {
            if let Some(&target) = facade.get(&name) {
                if target > own {
                    let rel = path.strip_prefix(src_root()).unwrap().display();
                    violations.push(format!(
                        "{rel}:{line}  层 `{}` 引用了更高的 `{}`（crate::{name}）",
                        LAYERS[own], LAYERS[target]
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "发现 {} 处上行层依赖（只允许 core ← infra ← services ← channels ← app）：\n{}",
        violations.len(),
        violations.join("\n")
    );
}
