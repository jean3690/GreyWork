//! 全局中间件：安全响应头 + Origin 校验（CSRF 纵深防御）。

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::config::ServerConfig;
use crate::state::AppState;

/// 给所有响应加安全响应头：`Content-Security-Policy`、`X-Frame-Options: DENY`、
/// `Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`，并兜底 `Cache-Control: no-store`。
///
/// `no-store`：命令返回值可能含凭据/文件内容，不该被任何中间缓存留存。
/// `nosniff`：避免浏览器把 JSON/二进制按内容猜成可执行类型。
///
/// 缓存头用 `or_insert`（**只在缺失时兜底**）：静态路由会先写好各自的按路径策略
/// （`/` 与其余资源 `no-cache`、`/assets/*` `immutable`），这里是更外层的 layer，
/// 若用 `insert` 会把它们全部冲掉。`/api/*` 不设自己的缓存头，于是仍拿到 `no-store`。
///
/// `csp` 由 [`content_security_policy`] 在路由装配时算好传入 —— 每个响应都重算一遍
/// 只是白烧 CPU（策略是启动期就定死的）。
pub async fn security_headers(request: Request, next: Next, csp: HeaderValue) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, csp);
    // 防点击劫持：`frame-ancestors 'none'` 是主线（现代浏览器），`X-Frame-Options` 兜底老代理/浏览器。
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    // 不把自托管地址/路径经 Referer 泄漏给任何跳转目标。
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// 服务端托管 SPA 的内容安全策略（`security_headers` 给每个响应带上）。
///
/// 对齐桌面壳 `tauri.conf.json` 的 CSP，去掉只有 Tauri 有的 `ipc:` 源，按 Web 补齐：
/// - `connect-src 'self'`：同源 `/api/*` 与 `/api/events`（ws/wss 同源已被 `'self'` 覆盖）；
/// - `media-src 'self' blob:`：入站视频 / 语音缩略图走 blob: URL（见 use-attachments.ts）；
/// - `worker-src 'self' blob:`：插件 code-runtime 用 blob Worker；
/// - `frame-ancestors 'none'`：禁止被 iframe 内嵌——有效会话能拉起 agent 进程，防点击劫持。
///
/// **`frame-src` 单独说**：桌面壳的 CSP 写死在打包配置里，所以桌面端只内嵌三个预设厂商；
/// 服务端的策略是这里现拼的，于是「自定义厂商」在服务端态下真正可用 ——
/// `GREYWORK_FRAME_ORIGINS` 里列出的 origin 会被追加上去。不配就没有 `frame-src`，
/// 回落到 `default-src 'self'`（即禁止跨源内嵌），与加这个开关之前的行为完全一致。
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
     script-src 'self' 'wasm-unsafe-eval'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     media-src 'self' blob:; \
     font-src 'self' data:; \
     connect-src 'self'; \
     worker-src 'self' blob:; \
     object-src 'none'; \
     base-uri 'self'; \
     form-action 'self'; \
     frame-ancestors 'none'";

/// 按配置拼出本进程要发的 CSP。
///
/// 只接受 `<scheme>://<host>[:port]` 形态的 origin，其余（含空格、分号、引号 —— 能让
/// 攻击者从配置里改写整条策略的字符）一律丢弃并**在启动日志里点名**：静默丢掉的话，
/// 症状是「配了却不生效、iframe 白屏、控制台之外看不到任何错误」，最难查的一类问题。
pub fn content_security_policy(config: &ServerConfig) -> HeaderValue {
    let mut origins = Vec::new();
    for origin in config.frame_origins.iter().map(String::as_str) {
        // 归一化实现收在共享层：`office_host_info` 回给渲染端的是同一份，
        // 两处若不归一化到同一形态（大小写、末尾斜杠），渲染端的比对必然误判。
        match greywork_host::csp::normalize_frame_origin(origin) {
            Ok(origin) => origins.push(origin),
            Err(reason) => greywork_host::log::warn(
                "server",
                format!("GREYWORK_FRAME_ORIGINS 里的 `{origin}` 被忽略：{reason}"),
            ),
        }
    }

    let mut policy = CONTENT_SECURITY_POLICY.to_string();
    if !origins.is_empty() {
        policy.push_str("; frame-src ");
        policy.push_str(&origins.join(" "));
    }
    // 上面的过滤保证了这里只可能失败于「策略串本身写错」，那属于编译期就该发现的问题。
    HeaderValue::from_str(&policy)
        .unwrap_or_else(|_| HeaderValue::from_static(CONTENT_SECURITY_POLICY))
}

/// 对非 GET/HEAD/OPTIONS 请求校验 `Origin`。
///
/// `SameSite=Strict` cookie 已是主防线（跨站请求根本不带 cookie）；这里是纵深：
/// 配置了 `allowed_origins` 时，凡不在白名单内的 Origin 一律 403。未配置时跳过
/// —— 同源部署无需维护白名单。
pub async fn origin_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.config.allowed_origins.is_empty() {
        return next.run(request).await;
    }
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(request).await;
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let allowed = origin
        .map(|origin| {
            state
                .config
                .allowed_origins
                .iter()
                .any(|item| item == origin)
        })
        .unwrap_or(false);
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Origin 不被允许" })),
        )
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_with(origins: &[&str]) -> String {
        let config = ServerConfig {
            frame_origins: origins.iter().map(|origin| origin.to_string()).collect(),
            ..ServerConfig::default()
        };
        content_security_policy(&config)
            .to_str()
            .expect("策略必须是合法 header 值")
            .to_string()
    }

    /// 不配 = 与加这个开关之前逐字节一致（`default-src 'self'` 接管 frame 加载）。
    #[test]
    fn no_frame_origins_leaves_policy_untouched() {
        let policy = policy_with(&[]);
        assert_eq!(policy, CONTENT_SECURITY_POLICY);
        assert!(
            !policy.contains("frame-src"),
            "不该凭空多出 frame-src：{policy}"
        );
    }

    #[test]
    fn configured_origins_are_appended_to_frame_src() {
        let policy = policy_with(&["https://docs.example.com", "http://127.0.0.1:8080/"]);
        assert!(
            policy.contains("; frame-src https://docs.example.com http://127.0.0.1:8080"),
            "末尾斜杠要剥掉：{policy}"
        );
        // 其余指令不受影响 —— frame-src 是追加，不是重写整条策略。
        assert!(policy.contains("frame-ancestors 'none'"), "{policy}");
        assert!(policy.contains("default-src 'self'"), "{policy}");
    }

    /// 能改写策略的输入一律丢弃；只丢该条，不影响其它条。
    #[test]
    fn hostile_origins_are_dropped_without_breaking_others() {
        // 只看 frame-src 那一段：`data:` / `'none'` 这些字样在别的指令里本来就有，
        // 拿整条策略做 `contains` 断言会假红。
        fn frame_src(policy: &str) -> &str {
            policy
                .split("frame-src ")
                .nth(1)
                .unwrap_or("")
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
        }

        for hostile in [
            "https://evil.example.com; script-src *",
            "https://evil.example.com'",
            "data:",
            "file:///etc",
            "javascript:alert(1)",
            "https://",
            "  ",
            "example.com",
        ] {
            let policy = policy_with(&[hostile, "https://docs.example.com"]);
            assert_eq!(
                frame_src(&policy),
                "https://docs.example.com",
                "`{hostile}` 不该进 frame-src：{policy}"
            );
            // 丢弃后策略仍是合法 header 值（拼接不会把分号数搞乱）。
            assert!(HeaderValue::from_str(&policy).is_ok(), "{policy}");
        }
    }

    #[test]
    fn all_hostile_origins_fall_back_to_base_policy() {
        let policy = policy_with(&["nonsense", "https://a b c"]);
        assert_eq!(policy, CONTENT_SECURITY_POLICY);
    }
}
