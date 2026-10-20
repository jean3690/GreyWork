//! 前端 net.fetch 能力的宿主侧代理。

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::http::read_limited;
use super::{
    DEFAULT_PLUGIN_FETCH_BYTES, MAX_PLUGIN_FETCH_BYTES_CEILING, MIN_PLUGIN_FETCH_BYTES,
    PLUGIN_FETCH_TIMEOUT,
};

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
    /// 仅 POST 允许携带的请求体（UTF-8，长度受 `max_bytes` 约束）。
    #[serde(default)]
    pub body: Option<String>,
    /// 插件 manifest 声明并经用户授权的域名白名单（来自前端 broker）。
    pub allowed_hosts: Vec<String>,
    /// 允许的 HTTP 方法子集（来自前端 broker；缺省 = GET/HEAD）。
    #[serde(default)]
    pub methods: Vec<String>,
    /// POST 允许的路径模板（来自前端 broker；仅 POST 使用）。
    #[serde(default)]
    pub paths: Vec<String>,
    /// 单次上下行字节上限（来自前端 broker；缺省 1 MiB，封顶 8 MiB）。
    #[serde(default)]
    pub max_bytes: Option<usize>,
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

/// 解析请求方法：必须是声明子集（缺省 GET/HEAD）之一，返回 (方法, 是否 POST)。
fn resolve_plugin_fetch_method(
    requested: Option<&str>,
    declared: &[String],
) -> Result<(reqwest::Method, bool), String> {
    let default_methods = ["GET", "HEAD"];
    let allowed: Vec<&str> = if declared.is_empty() {
        default_methods.to_vec()
    } else {
        declared.iter().map(String::as_str).collect()
    };
    let method = requested.unwrap_or("GET").to_ascii_uppercase();
    if !allowed.iter().any(|candidate| *candidate == method) {
        return Err(format!("net.fetch method is not declared: {method}"));
    }
    let resolved = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        "POST" => reqwest::Method::POST,
        other => {
            return Err(format!(
                "net.fetch method must be GET, HEAD or POST, got {other}"
            ))
        }
    };
    Ok((resolved, method == "POST"))
}

/// 单次字节上限：缺省 1 MiB，显式声明需落在 1 KiB .. 8 MiB（越界即拒）。
fn resolve_plugin_fetch_max_bytes(declared: Option<usize>) -> Result<usize, String> {
    match declared {
        None => Ok(DEFAULT_PLUGIN_FETCH_BYTES),
        Some(bytes) if (MIN_PLUGIN_FETCH_BYTES..=MAX_PLUGIN_FETCH_BYTES_CEILING).contains(&bytes) => {
            Ok(bytes)
        }
        Some(_) => Err(format!(
            "net.fetch maxBytes must be between {MIN_PLUGIN_FETCH_BYTES} and {MAX_PLUGIN_FETCH_BYTES_CEILING}"
        )),
    }
}

/// 路径模板匹配（与前端 broker 同构，纵深防御）：
/// `*` 匹配段内任意字符（不含 `/`），整段 `**` 匹配零个或多个路径段。
pub(super) fn plugin_fetch_path_matches(path: &str, template: &str) -> bool {
    let path_segments: Vec<&str> = path.split('/').collect();
    let template_segments: Vec<&str> = template.split('/').collect();
    segments_match(&path_segments, &template_segments)
}

fn segments_match(path: &[&str], template: &[&str]) -> bool {
    let Some((segment, rest)) = template.split_first() else {
        return path.is_empty();
    };
    if *segment == "**" {
        return (0..=path.len()).any(|index| segments_match(&path[index..], rest));
    }
    match path.split_first() {
        None => false,
        Some((path_segment, path_rest)) => {
            segment_matches(path_segment, segment) && segments_match(path_rest, rest)
        }
    }
}

/// 段内 glob：`*` 匹配任意字符序列（含空）。经典单星回溯匹配。
fn segment_matches(text: &str, pattern: &str) -> bool {
    let text = text.as_bytes();
    let pattern = pattern.as_bytes();
    let (mut ti, mut pi) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut star_text = 0usize;
    while ti < text.len() {
        if pi < pattern.len() && pattern[pi] == b'*' {
            star = Some(pi);
            star_text = ti;
            pi += 1;
        } else if pi < pattern.len() && pattern[pi] == text[ti] {
            ti += 1;
            pi += 1;
        } else if let Some(star_pi) = star {
            pi = star_pi + 1;
            star_text += 1;
            ti = star_text;
        } else {
            return false;
        }
    }
    while pi < pattern.len() && pattern[pi] == b'*' {
        pi += 1;
    }
    pi == pattern.len()
}

pub async fn plugin_net_fetch(request: PluginFetchRequest) -> Result<PluginFetchResponse, String> {
    let url = validate_plugin_fetch_url(&request.url, &request.allowed_hosts)?;
    let (method, is_post) =
        resolve_plugin_fetch_method(request.method.as_deref(), &request.methods)?;
    if is_post {
        if request.paths.is_empty() {
            return Err("net.fetch POST requires declared path templates".to_string());
        }
        if !request
            .paths
            .iter()
            .any(|template| plugin_fetch_path_matches(url.path(), template))
        {
            return Err(format!(
                "net.fetch POST path is not in the plugin allowlist: {}",
                url.path()
            ));
        }
    } else if request.body.is_some() {
        return Err("net.fetch body is only allowed for POST".to_string());
    }
    let max_bytes = resolve_plugin_fetch_max_bytes(request.max_bytes)?;
    if let Some(body) = &request.body {
        if body.len() > max_bytes {
            return Err(format!("net.fetch request body exceeds {max_bytes} bytes"));
        }
    }
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
    if let Some(body) = request.body {
        builder = builder.body(body);
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
    let bytes = read_limited(response, max_bytes).await?;
    let body = String::from_utf8(bytes)
        .map_err(|_| "net.fetch response is not valid UTF-8".to_string())?;
    Ok(PluginFetchResponse {
        status,
        ok,
        headers,
        body: Some(body),
    })
}
