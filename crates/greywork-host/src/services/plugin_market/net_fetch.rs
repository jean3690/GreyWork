//! 前端 net.fetch 能力的宿主侧代理。

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::http::read_limited;
use super::{MAX_PLUGIN_FETCH_BYTES, PLUGIN_FETCH_TIMEOUT};

/// 前端 net.fetch 能力 broker 的宿主侧代理。
///
/// 为什么不经 webview fetch：CSP `connect-src` 是文档级静态策略，无法按插件
/// hosts 白名单动态放宽；且防线放在 Rust 命令里，安装包 JS 无法绕过校验。
/// 白名单由前端 broker 传入，此处二次校验 —— 纵深防御，两边独立实现。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFetchRequest {
    pub url: String,
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// 插件 manifest 声明并经用户授权的域名白名单（来自前端 broker）。
    pub allowed_hosts: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFetchResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

fn plugin_fetch_host_matches(host: &str, allowed: &str) -> bool {
    host == allowed || (host.ends_with(&format!(".{allowed}")) && !allowed.contains('/'))
}

pub(super) fn validate_plugin_fetch_url(
    url: &str,
    allowed_hosts: &[String],
) -> Result<reqwest::Url, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|_| format!("net.fetch url is not absolute: {url}"))?;
    if parsed.scheme() != "https" {
        return Err("net.fetch only allows https: urls".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("net.fetch does not allow embedded credentials".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "net.fetch url has no host".to_string())?;
    if allowed_hosts.is_empty() {
        return Err("net.fetch requires a non-empty host allowlist".to_string());
    }
    if !allowed_hosts
        .iter()
        .any(|allowed| plugin_fetch_host_matches(host, allowed))
    {
        return Err(format!(
            "net.fetch host is not in the plugin allowlist: {host}"
        ));
    }
    Ok(parsed)
}

pub async fn plugin_net_fetch(request: PluginFetchRequest) -> Result<PluginFetchResponse, String> {
    let url = validate_plugin_fetch_url(&request.url, &request.allowed_hosts)?;
    let method = match request.method.as_deref() {
        None | Some("GET") => reqwest::Method::GET,
        Some("HEAD") => reqwest::Method::HEAD,
        Some(other) => return Err(format!("net.fetch method must be GET or HEAD, got {other}")),
    };
    for (name, value) in &request.headers {
        if name.trim().is_empty() || value.contains(['\r', '\n']) {
            return Err(format!("net.fetch invalid header: {name}"));
        }
        // 与前端 broker 同款禁改安全敏感头（纵深防御）。
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "authorization"
                | "cookie"
                | "host"
                | "origin"
                | "referer"
                | "connection"
                | "transfer-encoding"
        ) || lower.starts_with("sec-")
        {
            return Err(format!("net.fetch forbids the header: {name}"));
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        // 重定向可能跳出 hosts 白名单（如 30x 到 CDN），直接拒绝。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("net.fetch client build failed: {error}"))?;
    let mut builder = client
        .request(method.clone(), url)
        .header(reqwest::header::USER_AGENT, "GreyWork-Plugin/1")
        .timeout(PLUGIN_FETCH_TIMEOUT);
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = builder
        .send()
        .await
        .map_err(|error| format!("net.fetch request failed: {error}"))?;
    let status = response.status().as_u16();
    let ok = response.status().is_success();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    if method == reqwest::Method::HEAD {
        return Ok(PluginFetchResponse {
            status,
            ok,
            headers,
            body: None,
        });
    }
    let bytes = read_limited(response, MAX_PLUGIN_FETCH_BYTES).await?;
    let body = String::from_utf8(bytes)
        .map_err(|_| "net.fetch response is not valid UTF-8".to_string())?;
    Ok(PluginFetchResponse {
        status,
        ok,
        headers,
        body: Some(body),
    })
}
