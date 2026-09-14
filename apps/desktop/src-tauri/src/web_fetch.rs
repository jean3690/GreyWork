//! 网页抓取（用户主动输入的 URL）。
//!
//! 与 `plugin_market::plugin_net_fetch` 的分工：那是插件 manifest 白名单代理；这里允许
//! 任意用户 URL，所以防线换成 SSRF 加固——只允许 http/https、拒绝内嵌凭据、DNS 解析后
//! **逐个**校验地址、并把校验过的 IP 钉进 reqwest 客户端（`resolve_to_addrs`，关掉
//! DNS-rebinding 的 TOCTOU 窗口），手动跟随最多 5 跳且每跳重做校验。
//!
//! 只负责安全取回 HTML 原文；正文提取在前端用 DOMParser 做（不引 Rust HTML 依赖）。

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{
    ACCEPT, ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_TYPE, LOCATION, USER_AGENT,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};

/// 响应体上限：正文页一般远小于此，超限即拒（防被灌爆内存）。
const MAX_WEB_FETCH_BYTES: usize = 2 * 1024 * 1024;
/// 单跳整请求超时（含连接与响应头）。
const WEB_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// 响应体读取超时（服务端发完头挂死兜底）。
const WEB_FETCH_READ_TIMEOUT: Duration = Duration::from_secs(20);
/// 最多跟随的重定向跳数。
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchRequest {
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResponse {
    /// 跟随重定向后的最终地址（供前端做缓存键与展示）。
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    pub html: String,
}

/// 是否为不可访问的非公网地址（v4：环回/私网/链路本地/广播/未指定/组播/文档段/CGNAT/0.0.0.0-8）。
fn banned_v4(addr: &Ipv4Addr) -> bool {
    let octets = addr.octets();
    addr.is_loopback()
        || addr.is_private()
        || addr.is_link_local()
        || addr.is_broadcast()
        || addr.is_unspecified()
        || addr.is_multicast()
        || addr.is_documentation()
        || octets[0] == 0
        // 100.64.0.0/10 运营商级 NAT：仍是内网可路由段
        || (octets[0] == 100 && (octets[1] & 0xc0) == 64)
}

fn validate_ip(ip: &IpAddr) -> Result<(), String> {
    let banned = match ip {
        IpAddr::V4(v4) => banned_v4(v4),
        IpAddr::V6(v6) => {
            // IPv4-mapped（::ffff:a.b.c.d）要按 v4 规则判，否则 127.0.0.1 能绕过
            v6.to_ipv4_mapped()
                .map(|v4| banned_v4(&v4))
                .unwrap_or_else(|| {
                    let segments = v6.segments();
                    v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || (segments[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                    || (segments[0] & 0xffc0) == 0xfe80 // 链路本地 fe80::/10
                })
        }
    };
    if banned {
        return Err(format!("web fetch refuses non-public address: {ip}"));
    }
    Ok(())
}

/// 解析并校验起始 URL / 每跳重定向目标：绝对地址、仅 http/https、无内嵌凭据、有 host。
fn parse_target(raw: &str) -> Result<Url, String> {
    let url =
        Url::parse(raw.trim()).map_err(|_| format!("web fetch url is not absolute: {raw}"))?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "web fetch only allows http/https urls, got {other}"
            ))
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("web fetch does not allow embedded credentials".to_string());
    }
    if url.host_str().is_none() {
        return Err("web fetch url has no host".to_string());
    }
    Ok(url)
}

/// 解析 host 并逐个校验地址；`allow_local` 仅测试用（本地 mock 服务器在环回地址）。
async fn resolve_and_validate(
    host: &str,
    port: u16,
    allow_local: bool,
) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("web fetch dns resolve failed for {host}: {error}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!(
            "web fetch dns resolve returned no address for {host}"
        ));
    }
    if !allow_local {
        for addr in &addrs {
            validate_ip(&addr.ip())?;
        }
    }
    Ok(addrs)
}

/// 发一跳请求：客户端把 DNS 钉到已校验的 IP，关闭自动重定向（自己跟以便逐跳重校验）。
async fn fetch_once(
    url: &Url,
    host: &str,
    addrs: &[SocketAddr],
) -> Result<reqwest::Response, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(WEB_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        // 环境代理会绕过地址校验，直接禁用
        .no_proxy()
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|error| format!("web fetch client build failed: {error}"))?;
    client
        .get(url.clone())
        .header(USER_AGENT, "GreyWork-WebFetch/1")
        // reqwest 未开 gzip feature：声明只收未压缩体，避免拿到压缩字节当文本
        .header(ACCEPT_ENCODING, "identity")
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        )
        .send()
        .await
        .map_err(|error| format!("web fetch request failed: {error}"))
}

/// 带大小上限与读取超时的流式读体（避免把整个大响应拉进内存）。
async fn read_limited(response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes as u64)
    {
        return Err(format!("web fetch response exceeds {max_bytes} bytes"));
    }
    let mut stream = response.bytes_stream();
    let read = async {
        let mut out = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|error| format!("web fetch response read failed: {error}"))?;
            if out.len() + chunk.len() > max_bytes {
                return Err(format!("web fetch response exceeds {max_bytes} bytes"));
            }
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    };
    tokio::time::timeout(WEB_FETCH_READ_TIMEOUT, read)
        .await
        .map_err(|_| "web fetch response read timed out".to_string())?
}

/// 内容类型白名单（忽略 `;charset=` 等参数与大小写）。
fn readable_content_type(raw: Option<&str>) -> bool {
    match raw {
        None => true, // 少数服务器不给 Content-Type，按文本试读
        Some(value) => matches!(
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "text/html" | "application/xhtml+xml" | "text/plain"
        ),
    }
}

pub async fn fetch_page(start: &str) -> Result<WebFetchResponse, String> {
    fetch_page_with(start, false).await
}

/// 抓取主流程；`allow_local` 仅供本地测试（生产路径始终为 false）。
pub async fn fetch_page_with(start: &str, allow_local: bool) -> Result<WebFetchResponse, String> {
    let mut current = parse_target(start)?;
    let mut redirects = 0usize;
    loop {
        let host = current
            .host_str()
            .ok_or_else(|| "web fetch url has no host".to_string())?
            .to_string();
        let port = current
            .port_or_known_default()
            .ok_or_else(|| "web fetch url has no port".to_string())?;
        let addrs = resolve_and_validate(&host, port, allow_local).await?;
        let response = fetch_once(&current, &host, &addrs).await?;
        let status = response.status();

        if status.is_redirection() {
            if redirects >= MAX_REDIRECTS {
                return Err(format!(
                    "web fetch exceeded the redirect limit ({MAX_REDIRECTS})"
                ));
            }
            redirects += 1;
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "web fetch redirect had no location header".to_string())?;
            let next = current
                .join(location)
                .map_err(|error| format!("web fetch invalid redirect target: {error}"))?;
            current = parse_target(next.as_str())?;
            continue;
        }

        if !status.is_success() {
            return Err(format!("web fetch returned status {status}"));
        }

        if let Some(encoding) = response.headers().get(CONTENT_ENCODING) {
            let encoding = encoding.to_str().unwrap_or("");
            if !encoding.is_empty() && encoding != "identity" {
                return Err(format!(
                    "web fetch received unsupported content-encoding: {encoding}"
                ));
            }
        }

        let content_type_raw = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if !readable_content_type(content_type_raw.as_deref()) {
            return Err(format!(
                "web fetch unsupported content-type: {}",
                content_type_raw.unwrap_or_default()
            ));
        }

        let bytes = read_limited(response, MAX_WEB_FETCH_BYTES).await?;
        return Ok(WebFetchResponse {
            final_url: current.to_string(),
            status: status.as_u16(),
            content_type: content_type_raw.unwrap_or_else(|| "text/plain".to_string()),
            html: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
}

#[tauri::command]
pub async fn web_fetch(request: WebFetchRequest) -> Result<WebFetchResponse, String> {
    fetch_page(&request.url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 起本地 mock 服务器，按请求路径返回响应；返回 base URL（环回地址）。
    async fn serve_with(handler: fn(&str) -> String) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let read = stream.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]).to_string();
                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let _ = stream.write_all(handler(&path).as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn http_response(status: &str, content_type: &str, extra_headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn validate_ip_blocks_non_public_and_allows_public() {
        for raw in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            let ip: IpAddr = raw.parse().expect("ip");
            assert!(validate_ip(&ip).is_err(), "{raw} 应被拒");
        }
        for raw in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = raw.parse().expect("ip");
            assert!(validate_ip(&ip).is_ok(), "{raw} 应放行");
        }
    }

    #[test]
    fn parse_target_rejects_bad_scheme_and_credentials() {
        assert!(parse_target("file:///etc/passwd").is_err());
        assert!(parse_target("ftp://example.com").is_err());
        assert!(parse_target("https://user:pass@example.com/").is_err());
        assert!(parse_target("relative/path").is_err());
        assert!(parse_target("https://example.com/").is_ok());
    }

    #[tokio::test]
    async fn fetches_html_body() {
        let base = serve_with(|_| {
            http_response(
                "200 OK",
                "text/html; charset=utf-8",
                "",
                "<html><body>你好</body></html>",
            )
        })
        .await;
        let result = fetch_page_with(&base, true).await.expect("fetch ok");
        assert_eq!(result.status, 200);
        assert!(result.content_type.contains("text/html"));
        assert!(result.html.contains("你好"));
        assert!(result.final_url.starts_with(&base));
    }

    #[tokio::test]
    async fn follows_redirect_then_reads() {
        let base = serve_with(|path| {
            if path == "/final" {
                http_response("200 OK", "text/html", "", "<p>final</p>")
            } else {
                http_response("302 Found", "text/html", "Location: /final\r\n", "")
            }
        })
        .await;
        let result = fetch_page_with(&format!("{base}/"), true)
            .await
            .expect("fetch ok");
        assert!(result.html.contains("final"));
        assert!(result.final_url.ends_with("/final"));
    }

    #[tokio::test]
    async fn rejects_non_success_status() {
        let base = serve_with(|_| http_response("404 Not Found", "text/html", "", "nope")).await;
        let error = fetch_page_with(&base, true).await.expect_err("应报错");
        assert!(error.contains("404"), "{error}");
    }

    #[tokio::test]
    async fn rejects_unsupported_content_type() {
        let base = serve_with(|_| http_response("200 OK", "application/pdf", "", "%PDF")).await;
        let error = fetch_page_with(&base, true).await.expect_err("应报错");
        assert!(error.contains("content-type"), "{error}");
    }

    #[tokio::test]
    async fn rejects_oversized_body() {
        // Content-Length 声明超过上限：读体前即被拒（不必真的传 2 MiB）
        let base = serve_with(|_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_WEB_FETCH_BYTES + 1
            )
        })
        .await;
        let error = fetch_page_with(&base, true).await.expect_err("应报错");
        assert!(error.contains("exceeds"), "{error}");
    }

    #[tokio::test]
    async fn rejects_private_address_before_request() {
        let error = fetch_page_with("http://127.0.0.1:9/", false)
            .await
            .expect_err("应报错");
        assert!(error.contains("non-public"), "{error}");
    }
}
