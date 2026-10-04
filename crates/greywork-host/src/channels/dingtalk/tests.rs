use futures_util::SinkExt;
use serde_json::json;

use crate::channel_common::now_ms;
use crate::channel_media::MediaKind;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

#[test]
fn stream_url_percent_encodes_ticket() {
    let url = stream_url("wss://example.com/stream", "a+b/c=d");
    assert_eq!(url, "wss://example.com/stream?ticket=a%2Bb%2Fc%3Dd");
}

#[test]
fn open_body_subscribes_chatbot_topic() {
    let body = open_body("app-key", "app-secret");
    assert_eq!(body["clientId"], "app-key");
    assert_eq!(body["subscriptions"][0]["topic"], CHATBOT_TOPIC);
    assert_eq!(body["subscriptions"][0]["type"], "CALLBACK");
}

#[test]
fn parse_frame_reads_type_headers_and_data_string() {
    let raw = r#"{"specVersion":"1.0","type":"CALLBACK","headers":{"messageId":"m-1","topic":"/v1.0/im/bot/messages/get","contentType":"application/json"},"data":"{\"text\":{\"content\":\"你好\"}}"}"#;
    let frame = parse_frame(raw).expect("frame");
    assert_eq!(frame.kind, "CALLBACK");
    assert_eq!(frame.headers.message_id.as_deref(), Some("m-1"));
    let message: ChatbotMessage = serde_json::from_str(&frame.data).expect("message");
    assert_eq!(message.body_text(), "你好");
}

#[test]
fn ack_payload_echoes_message_id() {
    let ack: serde_json::Value = serde_json::from_str(&ack_payload("m-9")).expect("ack");
    assert_eq!(ack["code"], 200);
    assert_eq!(ack["headers"]["messageId"], "m-9");
    assert_eq!(ack["headers"]["contentType"], "application/json");
}

#[test]
fn chatbot_message_maps_peer_text_and_webhook() {
    let raw = r#"{"msgId":"msg-1","senderStaffId":"staff-1","senderNick":"阿甲","conversationId":"cid-1","conversationType":"1","sessionWebhook":"https://oapi.dingtalk.com/robot/sendBySession?session=x","sessionWebhookExpiredTime":1730000000000,"createAt":1729999999000,"text":{"content":"@机器人 帮我看看今天的安排"}}"#;
    let message: ChatbotMessage = serde_json::from_str(raw).expect("message");
    assert_eq!(message.peer_key().as_deref(), Some("staff-1"));
    assert_eq!(message.display_nick(), "阿甲");
    // 群聊 @ 前缀被剥掉
    assert_eq!(message.body_text(), "帮我看看今天的安排");
}

#[test]
fn reply_body_carries_at_and_text() {
    let body = reply_body("收到", Some("staff-1"));
    assert_eq!(body["msgtype"], "text");
    assert_eq!(body["text"]["content"], "收到");
    assert_eq!(body["at"]["atUserIds"][0], "staff-1");
    // 没有 staffId（群聊兜底）时不拼 at 字段，避免 @ 到空气
    let no_at = reply_body("收到", None);
    assert!(no_at["at"]
        .as_object()
        .map(|map| map.is_empty())
        .unwrap_or(false));
}

#[test]
fn peer_book_claims_owner_once_and_tracks_webhook_ttl() {
    let mut book = PeerBook::default();
    let raw = r#"{"senderStaffId":"staff-1","sessionWebhook":"https://x.test/hook","sessionWebhookExpiredTime":2000,"senderNick":"甲"}"#;
    let message: ChatbotMessage = serde_json::from_str(raw).expect("message");
    assert!(book.claim_owner("staff-1"));
    assert!(!book.claim_owner("staff-2"), "主人只认第一个发消息的人");
    assert!(book.remember("staff-1", &message));
    assert!(book.live_webhook("staff-1", 1000).is_some());
    assert!(
        book.live_webhook("staff-1", 3000).is_none(),
        "过期凭据不再可用"
    );
}

/* ===== 长连接：对本地 mock WS 服务器跑完整一轮 ===== */

/// 起一个 mock Stream 服务端：推一条机器人消息 → 校验 ack → 推一条他人消息 → 要求断开。
async fn spawn_stream_server() -> String {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        let message = |id: &str, staff: &str, content: &str| {
            let payload = serde_json::json!({
                "msgId": format!("msg-{id}"),
                "senderStaffId": staff,
                "senderNick": staff,
                "conversationId": "cid-1",
                "conversationType": "1",
                "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=x",
                "sessionWebhookExpiredTime": now_ms() + 60_000,
                "createAt": now_ms(),
                "msgtype": "text",
                "text": { "content": content },
            });
            serde_json::json!({
                    "specVersion": "1.0",
                    "type": "CALLBACK",
                    "headers": { "messageId": id, "topic": CHATBOT_TOPIC, "contentType": "application/json" },
                    "data": payload.to_string(),
                })
                .to_string()
        };
        let _ = socket
            .send(Message::text(message(
                "m-1",
                "staff-1",
                "帮我看看今天的安排",
            )))
            .await;
        // 等服务端回执（必须是同一 messageId）
        if let Some(Ok(Message::Text(ack))) = socket.next().await {
            let ack: serde_json::Value = serde_json::from_str(ack.as_str()).expect("ack json");
            assert_eq!(ack["code"], 200);
            assert_eq!(ack["headers"]["messageId"], "m-1");
        }
        let _ = socket
            .send(Message::text(message("m-2", "staff-2", "外人的消息")))
            .await;
        let _ = socket.next().await;
        let disconnect = serde_json::json!({
            "specVersion": "1.0",
            "type": "SYSTEM",
            "headers": { "messageId": "sys-1", "topic": "disconnect" },
            "data": "{}",
        })
        .to_string();
        let _ = socket.send(Message::text(disconnect)).await;
        let _ = socket.next().await;
        // 让连接活到客户端读完
        tokio::time::sleep(Duration::from_millis(200)).await;
    });
    format!("ws://{addr}")
}

#[tokio::test]
async fn stream_once_emits_authorized_inbound_and_acks_frames() {
    let url = spawn_stream_server().await;
    let events: Arc<parking_lot::Mutex<Vec<(String, serde_json::Value)>>> =
        Arc::new(parking_lot::Mutex::new(Vec::new()));
    let persisted: Arc<parking_lot::Mutex<Option<PeerBook>>> =
        Arc::new(parking_lot::Mutex::new(None));
    let deps = StreamDeps {
        sink: {
            let events = events.clone();
            Arc::new(move |event: &str, payload: serde_json::Value| {
                events.lock().push((event.to_string(), payload));
            })
        },
        persist: {
            let persisted = persisted.clone();
            Arc::new(move |peers: &PeerBook| {
                *persisted.lock() = Some(peers.clone());
            })
        },
        inbox: None,
    };
    let inner = Mutex::new(Inner::default());

    let end = tokio::time::timeout(
        Duration::from_secs(5),
        stream_once(&url, &deps, &inner, false),
    )
    .await
    .expect("长连接应自行结束")
    .expect("连接不应报错");
    assert_eq!(
        end,
        StreamEnd::Disconnected,
        "服务端 disconnect 应作为断开结局"
    );

    let inbound: Vec<serde_json::Value> = events
        .lock()
        .iter()
        .filter(|(event, _)| event == INBOUND_EVENT)
        .map(|(_, payload)| payload.clone())
        .collect();
    assert_eq!(inbound.len(), 1, "默认只放行归属人的消息：{inbound:?}");
    assert_eq!(inbound[0]["peerId"], "staff-1");
    assert_eq!(inbound[0]["text"], "帮我看看今天的安排");
    assert_eq!(inbound[0]["msgType"], "text");
    assert_eq!(inbound[0]["msgId"], "msg-m-1");

    let states: Vec<String> = events
        .lock()
        .iter()
        .filter(|(event, _)| event == STATE_EVENT)
        .map(|(_, payload)| payload["state"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        states.iter().any(|state| state == "connected"),
        "状态应翻到 connected：{states:?}"
    );

    let book = persisted.lock().clone().expect("联系人凭据应落盘");
    assert_eq!(book.owner.as_deref(), Some("staff-1"));
    assert!(
        book.live_webhook("staff-1", now_ms()).is_some(),
        "应记住可回发的 webhook"
    );
}

#[test]
fn reconnect_delay_caps_at_one_minute() {
    assert_eq!(reconnect_delay(0), Duration::from_secs(1));
    assert_eq!(reconnect_delay(3), Duration::from_secs(8));
    assert_eq!(reconnect_delay(20), RECONNECT_MAX_DELAY);
}

/* ===== 扫码创建应用：纯函数判定 ===== */

#[test]
fn classify_poll_covers_every_server_status() {
    let classify =
        |raw: &str| classify_poll(&serde_json::from_str::<PollBody>(raw).expect("轮询响应体"));
    // 等待中：信封里的 errcode 已在 post_registration 剥掉，status 才说明进展。
    assert_eq!(classify(r#"{"status":"WAITING"}"#), PollOutcome::Pending);
    // 官方连接器先 toUpperCase()，这里大小写不敏感。
    assert_eq!(classify(r#"{"status":"waiting"}"#), PollOutcome::Pending);
    assert_eq!(
        classify(r#"{"status":"SUCCESS","client_id":"a","client_secret":"b"}"#),
        PollOutcome::Done {
            client_id: "a".into(),
            client_secret: "b".into(),
        }
    );
    assert_eq!(
        classify(r#"{"status":"FAIL","fail_reason":"用户拒绝"}"#),
        PollOutcome::Failed("用户拒绝".into())
    );
    assert_eq!(
        classify(r#"{"status":"EXPIRED"}"#),
        PollOutcome::Expired(String::new())
    );
    // 凭证比 status 可信：SUCCESS 与凭证同时到达时按凭证判定。
    assert_eq!(
        classify(r#"{"status":"SUCCESS","client_id":"a","client_secret":"b"}"#),
        PollOutcome::Done {
            client_id: "a".into(),
            client_secret: "b".into(),
        }
    );
    // 缺凭证的 SUCCESS / 没见过的状态：如实报错，别当等待（否则会一直轮询到过期）。
    assert!(matches!(
        classify(r#"{"status":"SUCCESS"}"#),
        PollOutcome::Failed(_)
    ));
    assert!(matches!(
        classify(r#"{"status":"CREATING"}"#),
        PollOutcome::Failed(_)
    ));
    assert!(matches!(classify(r#"{}"#), PollOutcome::Failed(_)));
}

#[test]
fn poll_outcome_state_and_detail_are_screen_ready() {
    assert_eq!(PollOutcome::Pending.state(), "pending");
    assert_eq!(
        PollOutcome::Done {
            client_id: "a".into(),
            client_secret: "b".into()
        }
        .state(),
        "done"
    );
    assert_eq!(PollOutcome::Expired("x".into()).state(), "expired");
    assert_eq!(PollOutcome::Failed("x".into()).state(), "error");
    // 空描述交给界面出本地化文案，别把空提示丢上去。
    assert_eq!(PollOutcome::Failed(String::new()).detail(), None);
    assert_eq!(PollOutcome::Expired("  ".into()).detail(), None);
    assert_eq!(PollOutcome::Pending.detail(), None);
    assert_eq!(
        PollOutcome::Failed("服务端忙".into()).detail().as_deref(),
        Some("服务端忙")
    );
}

/* ===== 扫码创建应用：对本地 mock HTTP 服务器跑完整一轮 ===== */

/// 服务端真实形状：`init` 回 nonce，`begin` 回 device_code + 二维码链接。
const INIT_BODY: &str = r#"{"errcode":0,"errmsg":"ok","nonce":"n-123"}"#;
const BEGIN_BODY: &str = r#"{"errcode":0,"errmsg":"ok","device_code":"dc-abc","user_code":"AB12-CD34","verification_uri_complete":"https://oapi.dingtalk.com/app/registration/verify?code=AB12-CD34","expires_in":7200,"interval":3}"#;

/// 按脚本逐条应答的极简 HTTP 服务端（每连接一条请求，`Connection: close`），
/// 请求原文记录下来供断言 JSON 字段。
async fn spawn_registration_mock(
    responses: Vec<(u16, &'static str)>,
) -> (String, Arc<parking_lot::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let recorded: Arc<parking_lot::Mutex<Vec<String>>> =
        Arc::new(parking_lot::Mutex::new(Vec::new()));
    let sink = recorded.clone();
    tokio::spawn(async move {
        let mut index = 0usize;
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            // 读到请求头结束 + Content-Length 指定的 body，再回响应。
            let mut buffer: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let read = stream.read(&mut chunk).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..read]);
                let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n")
                else {
                    continue;
                };
                let head = String::from_utf8_lossy(&buffer[..position]).to_string();
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if buffer.len() >= position + 4 + length {
                    break;
                }
            }
            sink.lock()
                .push(String::from_utf8_lossy(&buffer).to_string());
            let (status, payload) = responses.get(index).copied().unwrap_or((500, "{}"));
            index += 1;
            let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
            if index >= responses.len() {
                break;
            }
        }
    });
    (format!("http://{addr}"), recorded)
}

fn session_for(device_code: &str) -> RegisterSession {
    RegisterSession {
        device_code: device_code.to_string(),
        expires_at: now_ms() + 60_000,
    }
}

#[tokio::test]
async fn begin_registration_sends_source_then_nonce_and_keeps_qr_link_verbatim() {
    let (base, recorded) = spawn_registration_mock(vec![(200, INIT_BODY), (200, BEGIN_BODY)]).await;
    let client = crate::http::shared_client(5).expect("client");
    let (session, dto) = begin_registration(&client, &base).await.expect("begin");

    assert_eq!(dto.user_code.as_deref(), Some("AB12-CD34"));
    assert_eq!(dto.expires_in, 7200, "服务端给了 expires_in，不该落兜底值");
    assert_eq!(dto.interval, 3);
    // 与飞书不同：官方连接器把 verification_uri_complete 原样编成二维码，不追加参数。
    assert_eq!(
        dto.qr_url,
        "https://oapi.dingtalk.com/app/registration/verify?code=AB12-CD34"
    );
    assert_eq!(session.device_code, "dc-abc");
    assert!(
        session.expires_at > now_ms() + 7_000_000,
        "有效期应按 expires_in 推算"
    );

    let sent = recorded.lock().join("\n");
    assert!(
        sent.contains("/app/registration/init"),
        "缺 init 请求: {sent}"
    );
    assert!(
        sent.contains("/app/registration/begin"),
        "缺 begin 请求: {sent}"
    );
    assert!(sent.contains("DING_DWS_CLAW"), "init 缺 source: {sent}");
    assert!(
        sent.contains("n-123"),
        "begin 未回填 init 拿到的 nonce: {sent}"
    );
}

#[tokio::test]
async fn begin_registration_falls_back_when_server_omits_expiry() {
    // 服务端没给 expires_in / interval 时用兜底值（官方连接器同值）。
    let (base, _recorded) = spawn_registration_mock(vec![
            (200, INIT_BODY),
            (
                200,
                r#"{"errcode":0,"device_code":"dc-abc","verification_uri_complete":"https://x.test/qr"}"#,
            ),
        ])
        .await;
    let client = crate::http::shared_client(5).expect("client");
    let (session, dto) = begin_registration(&client, &base).await.expect("begin");

    assert_eq!(dto.expires_in, DEFAULT_EXPIRE_IN);
    assert_eq!(dto.interval, DEFAULT_POLL_INTERVAL);
    assert_eq!(dto.user_code, None, "钉钉不保证下发配对码");
    assert!(
        session.expires_at > now_ms() + 7_000_000,
        "兜底的 7200s 有效期也要推算进会话"
    );
}

#[tokio::test]
async fn begin_registration_rejects_response_without_nonce() {
    let (base, _recorded) =
        spawn_registration_mock(vec![(200, r#"{"errcode":0,"errmsg":"ok"}"#)]).await;
    let client = crate::http::shared_client(5).expect("client");
    let error = begin_registration(&client, &base)
        .await
        .expect_err("缺 nonce 应当报错");
    assert!(error.contains("nonce"), "{error}");
}

#[tokio::test]
async fn poll_registration_returns_credentials_when_confirmed() {
    let (base, recorded) = spawn_registration_mock(vec![(
            200,
            r#"{"errcode":0,"errmsg":"ok","status":"SUCCESS","client_id":"ding-abc","client_secret":"secret-xyz"}"#,
        )])
        .await;
    let client = crate::http::shared_client(5).expect("client");
    let outcome = poll_registration(&client, &base, &session_for("dc-abc"))
        .await
        .expect("poll");

    assert_eq!(
        outcome,
        PollOutcome::Done {
            client_id: "ding-abc".into(),
            client_secret: "secret-xyz".into(),
        }
    );
    assert_eq!(outcome.state(), "done");
    let sent = recorded.lock().join("\n");
    assert!(
        sent.contains("dc-abc"),
        "轮询要把 device_code 带回去: {sent}"
    );
}

#[tokio::test]
async fn poll_registration_surfaces_nonzero_errcode_as_error() {
    // 与飞书相反：等待中是 errcode:0 + status:WAITING，非零 errcode 才是真失败。
    let (base, _recorded) = spawn_registration_mock(vec![(
        200,
        r#"{"errcode":40078,"errmsg":"device_code 已过期"}"#,
    )])
    .await;
    let client = crate::http::shared_client(5).expect("client");
    let error = poll_registration(&client, &base, &session_for("dc-abc"))
        .await
        .expect_err("errcode 非零应当报错");

    assert!(error.contains("40078"), "{error}");
    assert!(error.contains("device_code 已过期"), "{error}");
}

#[tokio::test]
async fn registration_rejects_non_json_body() {
    // 网关 5xx 页面之类：报错要带上响应片段，便于定位。
    let (base, _recorded) = spawn_registration_mock(vec![(502, "<html>bad gateway</html>")]).await;
    let client = crate::http::shared_client(5).expect("client");
    let error = begin_registration(&client, &base)
        .await
        .expect_err("非 JSON 响应应当报错");
    assert!(error.contains("bad gateway"), "{error}");
}

/* ===== 入站媒体：下载码提取 ===== */

#[test]
fn pending_media_reads_kinds_and_richtext() {
    let picture: ChatbotMessage = serde_json::from_value(json!({
        "msgtype": "picture",
        "downloadCode": "DC-1",
    }))
    .expect("图片消息");
    assert_eq!(
        picture.pending_media(),
        vec![(MediaKind::Image, "DC-1".to_string())]
    );

    // 视频 / 语音 / 文件也按各自类别收（顶层 downloadCode）。
    for (msgtype, kind) in [
        ("video", MediaKind::Video),
        ("audio", MediaKind::Audio),
        ("file", MediaKind::File),
    ] {
        let message: ChatbotMessage =
            serde_json::from_value(json!({ "msgtype": msgtype, "downloadCode": "DC-X" }))
                .expect("媒体消息");
        assert_eq!(
            message.pending_media(),
            vec![(kind, "DC-X".to_string())],
            "{msgtype} 应按 {kind:?} 收"
        );
    }

    // 富文本：content.richText 形状，混着文本项与图片项。
    let rich: ChatbotMessage = serde_json::from_value(json!({
        "msgtype": "richText",
        "content": { "richText": [
            { "text": "看这两张" },
            { "downloadCode": "DC-2" },
            { "picture": { "downloadCode": "DC-3" } },
        ] },
    }))
    .expect("富文本消息");
    assert_eq!(
        rich.pending_media(),
        vec![
            (MediaKind::Image, "DC-2".to_string()),
            (MediaKind::Image, "DC-3".to_string()),
        ]
    );

    // 顶层 richText 形状也认。
    let top: ChatbotMessage = serde_json::from_value(json!({
        "msgtype": "richText",
        "richText": [ { "downloadCode": "DC-4" } ],
    }))
    .expect("富文本消息");
    assert_eq!(
        top.pending_media(),
        vec![(MediaKind::Image, "DC-4".to_string())]
    );

    // 文本消息 / 空下载码都不产出媒体。
    let text: ChatbotMessage = serde_json::from_value(json!({
        "msgtype": "text",
        "text": { "content": "你好" },
    }))
    .expect("文本消息");
    assert!(text.pending_media().is_empty());
    let blank: ChatbotMessage = serde_json::from_value(json!({
        "msgtype": "picture",
        "downloadCode": "   ",
    }))
    .expect("空下载码");
    assert!(blank.pending_media().is_empty());
}

#[test]
fn pending_media_caps_at_max() {
    let items: Vec<serde_json::Value> = (0..(MAX_INBOUND_MEDIA + 3))
        .map(|index| json!({ "downloadCode": format!("DC-{index}") }))
        .collect();
    let message: ChatbotMessage =
        serde_json::from_value(json!({ "msgtype": "richText", "richText": items }))
            .expect("富文本消息");
    assert_eq!(message.pending_media().len(), MAX_INBOUND_MEDIA);
}
