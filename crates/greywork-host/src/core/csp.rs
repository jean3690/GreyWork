//! 内容安全策略里「可内嵌来源」的归一化。
//!
//! 只有一件事：把配置里的一个 origin 收成 `scheme://host[:port]` 的规范形态，非法即报错。
//! 单独成模块是因为它有**三个**调用点、且必须共用同一份实现：
//!
//! - 服务端拼 CSP `frame-src`（`apps/server/src/middleware.rs`）；
//! - 桌面壳的 CSP 漂移测试（`apps/desktop/src-tauri/src/lib.rs`）；
//! - 宿主事实查询回给渲染端的白名单（`crate::office::host_info`）。
//!
//! 渲染端拿 `new URL(url).origin` 与白名单比对，两边若不归一化到同一形态（大小写、末尾斜杠）
//! 必然误判 —— 症状是「明明配了却判成不可内嵌」，所以这里只能是唯一一份。

/// 归一化一个可内嵌 origin：`scheme://host[:port]`，小写、末尾斜杠剥掉，非法即报错。
///
/// 只接受 `<scheme>://<host>[:port]` 形态，其余（含空白、分号、引号 —— 能让攻击者从配置里
/// 改写整条 CSP 的字符）一律拒绝。
pub fn normalize_frame_origin(raw: &str) -> Result<String, &'static str> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("为空");
    }
    let (scheme, rest) = match trimmed.split_once("://") {
        Some(parts) => parts,
        None => return Err("缺少 `://`（CSP 的源必须带 scheme）"),
    };
    if !matches!(scheme, "http" | "https") {
        return Err("scheme 只支持 http / https");
    }
    if rest.is_empty() {
        return Err("缺少主机名");
    }
    // 主机名里出现这些字符说明配置串写错了，放行进去会把策略改写成别的东西。
    if rest.contains(|c: char| {
        c.is_whitespace() || matches!(c, ';' | '\'' | '"' | '*' | ',' | '\\' | '/')
    }) {
        return Err("主机部分含空白或引号等非法字符（只能写 `scheme://host[:port]`）");
    }
    // 小写化：浏览器的 `URL.origin` 一律小写，配置里写成 `https://Docs.Example.com`
    // 不归一化就会与渲染端的比对结果不符（表现为「明明配了却判成不可内嵌」）。
    Ok(trimmed.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::normalize_frame_origin;

    #[test]
    fn normalizes_case_and_trailing_slash() {
        assert_eq!(
            normalize_frame_origin("  https://Docs.Example.com/  ").unwrap(),
            "https://docs.example.com"
        );
        assert_eq!(
            normalize_frame_origin("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
    }

    /// 能改写策略的输入一律拒绝（放行进去等于让配置串决定整条 CSP）。
    #[test]
    fn rejects_hostile_or_malformed_origins() {
        for hostile in [
            "",
            "   ",
            "example.com",
            "file:///etc",
            "data:",
            "https://",
            "https://a b c",
            "https://evil.example.com'",
            "https://evil.example.com; script-src *",
        ] {
            assert!(
                normalize_frame_origin(hostile).is_err(),
                "`{hostile}` 应被拒"
            );
        }
    }
}
