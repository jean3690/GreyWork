//! 共享 HTTP 客户端构造 + 响应体读取超时。
//! 此前各处各自内联同一段 builder；读超时统一收口——reqwest 的
//! connect_timeout 只覆盖 TCP 建连，服务端 accept 后挂死不回包时 .json()/.text()
//! 会永久悬挂 async command，必须显式包超时。
//!
//! **客户端按连接超时缓存复用**：`reqwest::Client` 内部持连接池与 TLS 会话缓存，
//! 每次新建等于每次重做 TCP + TLS 握手、丢掉 keep-alive 与 HTTP/2 多路复用。
//! 此前是「每个请求一个 client」——LLM 一回合十几轮各建一个、每个频道命令各建一个，
//! 这条路径上的握手开销远超请求本身。

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;

/// 非流式响应体读取超时（服务端挂死兜底；流式路径各有独立 idle 超时）。
pub const RESPONSE_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// 连接超时秒数 → 已构建的 client。用 map 而非几个固定字段，是为了新增档位时不必改这里。
static CLIENTS: LazyLock<Mutex<HashMap<u64, reqwest::Client>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 取带指定连接超时的 reqwest client（默认 10s）；**同一超时值复用同一实例**。
///
/// `Client` 内部是 `Arc`，克隆只是加一次引用计数，调用点照旧拿所有权。
///
/// 刻意**不**开 `cookie_store`：默认关闭意味着复用的只有连接池，某个后端的
/// `Set-Cookie` 不会串到另一个后端。需要独立 cookie 域的调用方自行建 client。
pub fn shared_client(connect_timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut cache = CLIENTS.lock();
    if let Some(client) = cache.get(&connect_timeout_secs) {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(connect_timeout_secs))
        .build()
        .map_err(|error| format!("http client build failed: {error}"))?;
    cache.insert(connect_timeout_secs, client.clone());
    Ok(client)
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
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let Ok((mut stream, _)) = listener.accept().await {
                // 先把请求读干净：Windows 上带未读数据直接 drop socket 会触发 RST(10053)，
                // 客户端读 body 时报 ConnectionAborted。
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch).await;
                let body = "{\"ok\":true}";
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(header.as_bytes()).await;
                // flush + 半关闭：优雅发 FIN，让缓冲区数据先送达再关。
                let _ = stream.flush().await;
                let _ = stream.shutdown().await;
            }
        });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{addr}"))
            .send()
            .await
            .expect("request ok");
        let body: serde_json::Value = read_json(response, Duration::from_secs(5))
            .await
            .expect("parse");
        assert_eq!(body["ok"], true);
    }

    /// 起一个**保持连接**（keep-alive）的本地服务器，统计 accept 次数。
    ///
    /// 每个连接上循环读请求、逐个回响应，所以「客户端复用了连接」表现为 accept 计数不增长，
    /// 而不是每个请求各占一次 accept。
    async fn keep_alive_counting_server() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>)
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let accepts = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepts);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut scratch = [0u8; 1024];
                    loop {
                        // 连接上可能先后到达多个请求（keep-alive），逐个应答。
                        match stream.read(&mut scratch).await {
                            Ok(0) | Err(_) => return,
                            Ok(_) => {}
                        }
                        let body = "{\"ok\":true}";
                        // 刻意不带 Connection: close —— HTTP/1.1 默认 keep-alive。
                        let wire = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                            body.len(),
                            body
                        );
                        if stream.write_all(wire.as_bytes()).await.is_err() {
                            return;
                        }
                        let _ = stream.flush().await;
                    }
                });
            }
        });
        (format!("http://{addr}"), accepts)
    }

    /// `shared_client` 必须复用连接：两次请求只应产生**一次** TCP accept。
    ///
    /// 这条断言直接钉住「每个请求 new 一个 Client」的回归——那种写法每次都会建新连接池，
    /// accept 会数到 2。
    #[tokio::test]
    async fn shared_client_reuses_connection_across_calls() {
        use std::sync::atomic::Ordering;

        let (url, accepts) = keep_alive_counting_server().await;
        for _ in 0..2 {
            let response = shared_client(7)
                .expect("client")
                .get(&url)
                .send()
                .await
                .expect("send");
            // .text() 消费 body，连接随即归还连接池；必须读完才会走复用路径。
            let _ = response.text().await.expect("body");
        }
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            1,
            "两次请求应复用同一条 TCP 连接（每请求新建 client 会数到 2）"
        );
    }
}
