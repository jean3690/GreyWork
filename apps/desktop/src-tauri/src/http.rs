//! 共享 HTTP 客户端构造 + 响应体读取超时。
//! 此前各处各自内联同一段 builder；读超时统一收口——reqwest 的
//! connect_timeout 只覆盖 TCP 建连，服务端 accept 后挂死不回包时 .json()/.text()
//! 会永久悬挂 async command，必须显式包超时。

use serde::de::DeserializeOwned;
use std::time::Duration;

/// 非流式响应体读取超时（服务端挂死兜底；流式路径各有独立 idle 超时）。
pub const RESPONSE_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// 构造带指定连接超时的 reqwest client（默认 10s）。
pub fn shared_client(connect_timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_timeout_secs))
        .build()
        .map_err(|error| format!("http client build failed: {error}"))
}

/// 带超时读取 JSON 响应体。
pub async fn read_json<T>(response: reqwest::Response, timeout: Duration) -> Result<T, String>
where
    T: DeserializeOwned,
{
    tokio::time::timeout(timeout, response.json::<T>())
        .await
        .map_err(|_| format!("响应读取超时（{} 秒无数据）", timeout.as_secs()))?
        .map_err(|error| format!("响应解析失败: {error}"))
}

/// 带超时读取文本响应体（错误体诊断等）。
pub async fn read_text(response: reqwest::Response, timeout: Duration) -> Result<String, String> {
    tokio::time::timeout(timeout, response.text())
        .await
        .map_err(|_| format!("响应读取超时（{} 秒无数据）", timeout.as_secs()))?
        .map_err(|error| format!("响应读取失败: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 起一个「发响应头后挂死（不关连接不发 body）」的本地服务器。
    async fn hang_server() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n";
                let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, header.as_bytes()).await;
                // 保持连接不写 body：挂死
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn read_json_times_out_on_hung_server() {
        let url = hang_server().await;
        let client = reqwest::Client::new();
        let response = client.get(&url).send().await.expect("headers arrive");
        let result = read_json::<serde_json::Value>(response, Duration::from_millis(300)).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("超时"));
    }

    #[tokio::test]
    async fn read_json_parses_complete_body() {
        // 正常路径：完整 body 在超时内解析成功
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let body = "{\"ok\":true}";
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, header.as_bytes()).await;
            }
        });
        let client = reqwest::Client::new();
        let response = client
            .get(&format!("http://{addr}"))
            .send()
            .await
            .expect("request ok");
        let body: serde_json::Value = read_json(response, Duration::from_secs(5))
            .await
            .expect("parse");
        assert_eq!(body["ok"], true);
    }
}
