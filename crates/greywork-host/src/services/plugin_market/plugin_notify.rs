//! 前端 notify 能力的宿主侧门面：**校验 + 归属前缀**，真正投递留给桌面壳。
//!
//! 通知是**旁路上报**：失败即降级、绝不阻塞主流程（见桌面壳 `notify.rs`）。
//! 因此能力本体收在这里做成纯函数 `compose_plugin_notify`——校验与合成可单测，
//! 系统调用（`tauri-plugin-notification`）留给桌面壳，headless 服务端没有对应物，
//! 故命令登记为 `desktop: true`（`dispatch` 直接拒绝）。
//!
//! 安全语义：
//! - **归属不可伪造**：标题统一加 `[<plugin-id>] ` 前缀，插件无法伪装成宿主通知；
//! - **布局不可注入**：标题禁一切控制字符，正文只放行换行（其余控制字符拒绝）；
//! - **长度有界**：标题 ≤64、正文 ≤240 字符（按 Unicode 码点计）。
//!
//! v1 不支持 `icon`（需要路径沙箱；roadmap 里的 `icon?` 延后）。

use serde::{Deserialize, Serialize};

use super::validate::validate_key;

/// 标题字符上限（含插件前缀前）。
const MAX_NOTIFY_TITLE_CHARS: usize = 64;
/// 正文字符上限。
const MAX_NOTIFY_BODY_CHARS: usize = 240;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNotifyRequest {
    /// 发起调用的插件 id（前端 broker 传入，宿主侧仍按 `validate_key` 复核）。
    pub plugin_id: String,
    pub title: String,
    pub body: String,
}

/// 校验通过后**实际展示**的文案（标题已带归属前缀）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNotifyResponse {
    pub title: String,
    pub body: String,
}

/// 校验并合成通知文案；桌面壳拿到结果后调用 `notify::send`。
pub fn compose_plugin_notify(request: PluginNotifyRequest) -> Result<PluginNotifyResponse, String> {
    validate_key(&request.plugin_id, "plugin id")?;
    let title = request.title.trim();
    let body = request.body.trim();
    if title.is_empty() {
        return Err("notify title must not be empty".to_string());
    }
    if body.is_empty() {
        return Err("notify body must not be empty".to_string());
    }
    if title.chars().count() > MAX_NOTIFY_TITLE_CHARS {
        return Err(format!(
            "notify title exceeds {MAX_NOTIFY_TITLE_CHARS} characters"
        ));
    }
    if body.chars().count() > MAX_NOTIFY_BODY_CHARS {
        return Err(format!(
            "notify body exceeds {MAX_NOTIFY_BODY_CHARS} characters"
        ));
    }
    // 控制字符会破坏通知布局（换行/制表符可伪造其它条目）；标题一律拒绝，
    // 正文只放行换行。
    if title.chars().any(char::is_control) {
        return Err("notify title must not contain control characters".to_string());
    }
    if body.chars().any(|ch| ch.is_control() && ch != '\n') {
        return Err(
            "notify body must not contain control characters (newlines allowed)".to_string(),
        );
    }
    Ok(PluginNotifyResponse {
        title: format!("[{}] {}", request.plugin_id, title),
        body: body.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(plugin_id: &str, title: &str, body: &str) -> PluginNotifyRequest {
        PluginNotifyRequest {
            plugin_id: plugin_id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
        }
    }

    #[test]
    fn composes_attributed_title_and_trims() {
        let payload =
            compose_plugin_notify(request("demo.notify", "  构建完成  ", "  一切正常  ")).unwrap();
        assert_eq!(payload.title, "[demo.notify] 构建完成");
        assert_eq!(payload.body, "一切正常");
    }

    #[test]
    fn rejects_empty_title_or_body() {
        assert!(compose_plugin_notify(request("demo.notify", "   ", "正文")).is_err());
        assert!(compose_plugin_notify(request("demo.notify", "标题", "  ")).is_err());
    }

    #[test]
    fn enforces_length_limits() {
        let ok_title = "资".repeat(MAX_NOTIFY_TITLE_CHARS);
        assert!(compose_plugin_notify(request("demo.notify", &ok_title, "x")).is_ok());
        let long_title = "资".repeat(MAX_NOTIFY_TITLE_CHARS + 1);
        let error = compose_plugin_notify(request("demo.notify", &long_title, "x")).unwrap_err();
        assert!(error.contains("title exceeds"), "{error}");

        let ok_body = "文".repeat(MAX_NOTIFY_BODY_CHARS);
        assert!(compose_plugin_notify(request("demo.notify", "t", &ok_body)).is_ok());
        let long_body = "文".repeat(MAX_NOTIFY_BODY_CHARS + 1);
        let error = compose_plugin_notify(request("demo.notify", "t", &long_body)).unwrap_err();
        assert!(error.contains("body exceeds"), "{error}");
    }

    #[test]
    fn rejects_control_characters() {
        let error = compose_plugin_notify(request("demo.notify", "bad\nnewline", "x")).unwrap_err();
        assert!(error.contains("title must not contain control"), "{error}");

        // 正文放行换行。
        assert!(compose_plugin_notify(request("demo.notify", "t", "line1\nline2")).is_ok());
        // 其它控制字符仍拒绝。
        let error = compose_plugin_notify(request("demo.notify", "t", "tab\there")).unwrap_err();
        assert!(error.contains("body must not contain control"), "{error}");
    }

    #[test]
    fn rejects_unsafe_plugin_id() {
        assert!(compose_plugin_notify(request("", "t", "b")).is_err());
        assert!(compose_plugin_notify(request("Bad Id", "t", "b")).is_err());
        assert!(compose_plugin_notify(request("../evil", "t", "b")).is_err());
    }
}
