//! 微信通道协议层集成验证：登录二维码 → 扫码状态 → 长轮询收消息 → 发消息 / 输入状态。
//!
//! 打本地 mock iLink 服务器（不依赖外网与真实微信账号），逐项断言：
//! - 请求形状（路径、Authorization / AuthorizationType / X-WECHAT-UIN 头、请求体字段）；
//! - 响应解析（二维码内容、扫码状态机、消息文本与语音转写、同步游标）。
//!
//! 与单测的分工：`src/wechat.rs` 里的单测覆盖纯函数（口令头、baseurl 校验、消息归一），
//! 这里覆盖「线上形状」——只有真正发一次 HTTP 才会暴露的问题（头名、字段名、JSON 结构）。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use greywork_lib::wechat::{
    extract_text, fetch_login_qr, fetch_typing_ticket, get_updates, poll_login_status,
    send_text_message, send_typing,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[derive(Default)]
struct MockState {
    requests: Vec<RecordedRequest>,
    qr_polls: u32,
}

struct RecordedRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl RecordedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn read_request(stream: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        if let Some(position) = find_header_end(&buffer) {
            let head = String::from_utf8_lossy(&buffer[..position]).to_string();
            let content_length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            while buffer.len() < position + 4 + content_length {
                let read = stream.read(&mut chunk).await.ok()?;
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            let body = String::from_utf8_lossy(&buffer[position + 4..]).to_string();
            let mut lines = head.lines();
            let request_line = lines.next().unwrap_or_default().to_string();
            let mut parts = request_line.split_whitespace();
            let method = parts.next().unwrap_or_default().to_string();
            let path = parts.next().unwrap_or_default().to_string();
            let headers = lines
                .filter_map(|line| {
                    line.split_once(':')
                        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
                })
                .collect();
            return Some(RecordedRequest {
                method,
                path,
                headers,
                body,
            });
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn json_response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
}

fn route(path: &str, state: &Arc<Mutex<MockState>>) -> String {
    match path.split('?').next().unwrap_or_default() {
        "/ilink/bot/get_bot_qrcode" => json_response(
            r#"{"qrcode":"qr-1","qrcode_img_content":"https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=qr-1&bot_type=3","ret":0}"#,
        ),
        "/ilink/bot/get_qrcode_status" => {
            let mut guard = state.lock().expect("state");
            guard.qr_polls += 1;
            if guard.qr_polls <= 1 {
                json_response(r#"{"ret":0,"status":"wait"}"#)
            } else {
                json_response(
                    r#"{"ret":0,"status":"confirmed","bot_token":"bot-token-1","ilink_bot_id":"bot-1@im.bot","baseurl":"https://ilinkai.weixin.qq.com","ilink_user_id":"user-1@im.wechat"}"#,
                )
            }
        }
        "/ilink/bot/getupdates" => json_response(
            r#"{"ret":0,"msgs":[{"message_id":11,"from_user_id":"user-1@im.wechat","to_user_id":"bot-1@im.bot","context_token":"ctx-1","create_time_ms":1730000000000,"message_type":1,"item_list":[{"type":1,"text_item":{"text":"hello"}},{"type":3,"voice_item":{"text":"语音转写"}}]},{"message_id":12,"from_user_id":"bot-1@im.bot","context_token":"ctx-1","message_type":2,"item_list":[{"type":1,"text_item":{"text":"回声"}}]}],"get_updates_buf":"cursor-1","longpolling_timeout_ms":35000}"#,
        ),
        "/ilink/bot/sendmessage" => json_response(r#"{"ret":0}"#),
        "/ilink/bot/getconfig" => json_response(r#"{"ret":0,"typing_ticket":"ticket-1"}"#),
        "/ilink/bot/sendtyping" => json_response(r#"{"ret":0}"#),
        _ => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
    }
}

async fn spawn_mock() -> (String, Arc<Mutex<MockState>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let state: Arc<Mutex<MockState>> = Arc::new(Mutex::new(MockState::default()));
    let shared = state.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let shared = shared.clone();
            tokio::spawn(async move {
                if let Some(request) = read_request(&mut stream).await {
                    {
                        let mut guard = shared.lock().expect("state");
                        guard.requests.push(request);
                    }
                    let path = {
                        let guard = shared.lock().expect("state");
                        guard
                            .requests
                            .last()
                            .map(|item| item.path.clone())
                            .unwrap_or_default()
                    };
                    let response = route(&path, &shared);
                    let _ = stream.write_all(response.as_bytes()).await;
                }
                let _ = stream.shutdown().await;
            });
        }
    });
    (format!("http://{addr}"), state)
}

#[tokio::test]
async fn login_flow_and_dialogue_round_trip() {
    let (base, state) = spawn_mock().await;
    let client = reqwest::Client::new();

    // 1) 登录二维码
    let qr = fetch_login_qr(&client, &base).await.expect("qr");
    assert_eq!(qr.qrcode, "qr-1");
    assert!(
        qr.qrcode_img_content
            .starts_with("https://liteapp.weixin.qq.com/"),
        "二维码内容是要编码的链接：{}",
        qr.qrcode_img_content
    );

    // 2) 扫码状态：先 wait 后 confirmed
    let first = poll_login_status(&client, &base, &qr.qrcode)
        .await
        .expect("first poll");
    assert_eq!(first.status, "wait");
    assert!(first.bot_token.is_none());
    let second = poll_login_status(&client, &base, &qr.qrcode)
        .await
        .expect("second poll");
    assert_eq!(second.status, "confirmed");
    assert_eq!(second.bot_token.as_deref(), Some("bot-token-1"));
    assert_eq!(second.ilink_bot_id.as_deref(), Some("bot-1@im.bot"));
    assert_eq!(second.ilink_user_id.as_deref(), Some("user-1@im.wechat"));
    assert_eq!(
        second.baseurl.as_deref(),
        Some("https://ilinkai.weixin.qq.com")
    );

    // 3) 长轮询收消息：只归一用户消息（bot 回声由 message_type 过滤，宿主层做）
    let updates = get_updates(&client, &base, "bot-token-1", "", Duration::from_secs(5))
        .await
        .expect("updates");
    assert_eq!(updates.error_code(), None);
    assert_eq!(updates.get_updates_buf.as_deref(), Some("cursor-1"));
    assert_eq!(updates.longpolling_timeout_ms, Some(35000));
    let messages = updates.msgs.clone().unwrap_or_default();
    assert_eq!(messages.len(), 2);
    assert_eq!(extract_text(&messages[0]), "hello\n语音转写");
    assert_eq!(messages[0].context_token.as_deref(), Some("ctx-1"));

    // 4) 回消息：context_token 必须原样带上
    send_text_message(
        &client,
        &base,
        "bot-token-1",
        "user-1@im.wechat",
        "ctx-1",
        "收到",
    )
    .await
    .expect("send");

    // 5) 输入状态：先取票据再发状态
    let ticket = fetch_typing_ticket(&client, &base, "bot-token-1", "user-1@im.wechat", "ctx-1")
        .await
        .expect("ticket");
    assert_eq!(ticket.as_deref(), Some("ticket-1"));
    send_typing(
        &client,
        &base,
        "bot-token-1",
        "user-1@im.wechat",
        "ticket-1",
        true,
    )
    .await
    .expect("typing");

    // 6) 请求形状断言（头 + 体）
    let guard = state.lock().expect("state");
    let send = guard
        .requests
        .iter()
        .find(|request| request.path == "/ilink/bot/sendmessage")
        .expect("sendmessage recorded");
    assert_eq!(send.method, "POST");
    assert_eq!(send.header("Authorization"), Some("Bearer bot-token-1"));
    assert_eq!(send.header("AuthorizationType"), Some("ilink_bot_token"));
    assert!(
        send.body.contains("\"context_token\":\"ctx-1\""),
        "body={}",
        send.body
    );
    assert!(
        send.body.contains("\"message_type\":2"),
        "body={}",
        send.body
    );
    assert!(send.body.contains("\"type\":1"), "body={}", send.body);
    assert!(
        send.body.contains("channel_version"),
        "base_info 必须随请求上行：{}",
        send.body
    );

    // X-WECHAT-UIN：base64(十进制 uint32)，每次请求都换。
    // 例外是扫码状态轮询 —— 官方客户端在该接口只带 iLink-App-ClientVersion（登录前无 bot 身份）。
    let uin_requests: Vec<&RecordedRequest> = guard
        .requests
        .iter()
        .filter(|request| !request.path.starts_with("/ilink/bot/get_qrcode_status"))
        .collect();
    assert_eq!(uin_requests.len(), 5, "登录前轮询之外共 5 个请求");
    for request in &uin_requests {
        let encoded = request
            .header("X-WECHAT-UIN")
            .unwrap_or_else(|| panic!("缺 UIN 头：{}", request.path));
        let decoded = String::from_utf8(BASE64.decode(encoded).expect("base64")).expect("utf8");
        assert!(
            decoded.chars().all(|value| value.is_ascii_digit()) && decoded.parse::<u64>().is_ok(),
            "UIN 必须是十进制数字串：{decoded}"
        );
    }
    let typing = guard
        .requests
        .iter()
        .find(|request| request.path == "/ilink/bot/sendtyping")
        .expect("sendtyping recorded");
    assert!(typing.body.contains("\"status\":1"), "body={}", typing.body);
}

#[tokio::test]
async fn long_poll_timeout_is_treated_as_empty_round() {
    // 服务端挂住不响应：客户端超时后按「本轮无消息」返回，游标原样带回。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer).await;
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });
    let client = reqwest::Client::new();
    let updates = get_updates(
        &client,
        &format!("http://{addr}"),
        "token",
        "cursor-keep",
        Duration::from_millis(300),
    )
    .await
    .expect("timeout is not an error");
    assert_eq!(updates.error_code(), None);
    assert_eq!(updates.get_updates_buf.as_deref(), Some("cursor-keep"));
    assert!(updates.msgs.is_none());
}
