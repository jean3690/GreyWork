use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

use crate::channel_common::now_ms;
use crate::channel_media::MediaKind;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

#[test]
fn frame_round_trips_through_protobuf_codec() {
    let frame = Frame {
        seq_id: 7,
        log_id: 42,
        service: 1,
        method: 1,
        headers: vec![
            ("type".into(), "event".into()),
            ("message_id".into(), "m-1".into()),
        ],
        payload_encoding: "json".into(),
        payload_type: "event".into(),
        payload: br#"{"hello":"world"}"#.to_vec(),
    };
    let encoded = frame.encode();
    let decoded = Frame::decode(&encoded).expect("decode");
    assert_eq!(decoded, frame);
}

#[test]
fn frame_decode_skips_unknown_fields() {
    // 追加字段 9（LogIDNew，string）与 10（varint），应被跳过而不是报错。
    let mut bytes = Frame {
        seq_id: 3,
        method: 1,
        payload: b"x".to_vec(),
        ..Default::default()
    }
    .encode();
    write_bytes_field(&mut bytes, 9, b"log-new");
    write_varint_field(&mut bytes, 10, 5);
    let decoded = Frame::decode(&bytes).expect("decode");
    assert_eq!(decoded.seq_id, 3);
    assert_eq!(decoded.payload, b"x".to_vec());
}

#[test]
fn ack_payload_is_official_response_shape() {
    let ack: serde_json::Value = serde_json::from_slice(&ack_payload()).expect("ack json");
    assert_eq!(ack["code"], 200);
    assert!(ack["headers"].is_object());
}

#[test]
fn endpoint_body_uses_official_field_names() {
    let body = endpoint_body("cli_x", "secret");
    assert_eq!(body["AppID"], "cli_x");
    assert_eq!(body["AppSecret"], "secret");
}

#[test]
fn message_event_maps_peer_text_and_reply_target() {
    let raw = r#"{
            "header": {"event_id":"e-1","event_type":"im.message.receive_v1"},
            "event": {
                "sender": {"sender_id": {"open_id":"ou_abc","user_id":"uid-1"}, "sender_type":"user"},
                "message": {"message_id":"om-1","chat_id":"oc-1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"帮我看看今天的安排\"}"}
            }
        }"#;
    let event: MessageEvent = serde_json::from_str(raw).expect("event");
    assert_eq!(event.header.event_type.as_deref(), Some(MESSAGE_EVENT));
    assert_eq!(event.peer_key().as_deref(), Some("ou_abc"));
    assert_eq!(
        event.reply_target(),
        Some(("open_id", "ou_abc".to_string()))
    );
    let message = event.event.message.as_ref().expect("message");
    assert_eq!(message_text(message), "帮我看看今天的安排");
}

#[test]
fn group_event_replies_to_chat_and_strips_mention() {
    let raw = r#"{
            "header": {"event_type":"im.message.receive_v1"},
            "event": {
                "sender": {"sender_id": {"open_id":"ou_abc"}},
                "message": {"message_id":"om-2","chat_id":"oc-9","chat_type":"group","message_type":"text","content":"{\"text\":\"@_user_1 在吗\"}"}
            }
        }"#;
    let event: MessageEvent = serde_json::from_str(raw).expect("event");
    assert_eq!(
        event.peer_key().as_deref(),
        Some("oc-9"),
        "群聊以会话为主体"
    );
    assert_eq!(event.reply_target(), Some(("chat_id", "oc-9".to_string())));
    // 文本原样保留（飞书会把 @ 替换成 @_user_N 占位，模型自己忽略即可）
    let message = event.event.message.as_ref().expect("message");
    assert_eq!(message_text(message), "@_user_1 在吗");
}

#[test]
fn non_text_and_broken_content_yield_empty_text() {
    let image = EventMessage {
        message_type: Some("image".into()),
        content: Some("{\"image_key\":\"img-1\"}".into()),
        ..Default::default()
    };
    assert_eq!(message_text(&image), "");
    let broken = EventMessage {
        content: Some("not-json".into()),
        ..Default::default()
    };
    assert_eq!(message_text(&broken), "");
}

#[test]
fn text_message_body_stringifies_content() {
    let body = text_message_body("ou_abc", "收到");
    assert_eq!(body["receive_id"], "ou_abc");
    assert_eq!(body["msg_type"], "text");
    let content: serde_json::Value =
        serde_json::from_str(body["content"].as_str().expect("content is api string"))
            .expect("inner json");
    assert_eq!(content["text"], "收到");
}

#[test]
fn content_media_extracts_image_and_file_keys() {
    let image = EventMessage {
        message_type: Some("image".into()),
        content: Some(r#"{"image_key":"img_v2_abc"}"#.into()),
        ..Default::default()
    };
    let media = content_media(&image);
    assert_eq!(media.len(), 1);
    assert_eq!(media[0].kind, MediaKind::Image);
    assert_eq!(media[0].resource_type, "image");
    assert_eq!(media[0].file_key, "img_v2_abc");

    let file = EventMessage {
        message_type: Some("file".into()),
        content: Some(r#"{"file_key":"file_v2_x","file_name":"报表.xlsx"}"#.into()),
        ..Default::default()
    };
    let media = content_media(&file);
    assert_eq!(media[0].kind, MediaKind::File);
    assert_eq!(media[0].name, "报表.xlsx");
    assert_eq!(media[0].resource_type, "file");

    let audio = EventMessage {
        message_type: Some("audio".into()),
        content: Some(r#"{"file_key":"audio_v2_x","duration":3000}"#.into()),
        ..Default::default()
    };
    let media = content_media(&audio);
    assert_eq!(media[0].kind, MediaKind::Audio);
    assert_eq!(media[0].resource_type, "file");

    let video = EventMessage {
        message_type: Some("media".into()),
        content: Some(r#"{"file_key":"video_v2_x","file_name":"片.mp4"}"#.into()),
        ..Default::default()
    };
    let media = content_media(&video);
    assert_eq!(media[0].kind, MediaKind::Video);
    assert_eq!(media[0].name, "片.mp4");

    let text = EventMessage {
        message_type: Some("text".into()),
        content: Some(r#"{"text":"hi"}"#.into()),
        ..Default::default()
    };
    assert!(content_media(&text).is_empty(), "文本消息没有可下载资源");
}

#[test]
fn message_body_stringifies_media_content() {
    let body = message_body(
        "ou_abc",
        "image",
        &serde_json::json!({ "image_key": "img_1" }),
    );
    assert_eq!(body["msg_type"], "image");
    let content: serde_json::Value =
        serde_json::from_str(body["content"].as_str().expect("content is api string"))
            .expect("inner json");
    assert_eq!(content["image_key"], "img_1");
}

#[test]
fn fragments_reassemble_by_sum_and_seq() {
    let mut fragments = Fragments::default();
    assert!(fragments.push("m-1", 2, 0, b"hello ".to_vec()).is_none());
    let joined = fragments
        .push("m-1", 2, 1, b"world".to_vec())
        .expect("joined");
    assert_eq!(joined, b"hello world".to_vec());
}

#[test]
fn peer_book_claims_owner_once_and_keeps_reply_target() {
    let raw = r#"{
            "header": {"event_type":"im.message.receive_v1"},
            "event": {
                "sender": {"sender_id": {"open_id":"ou_a"}},
                "message": {"message_id":"om-1","chat_id":"oc-1","chat_type":"p2p","message_type":"text","content":"{\"text\":\"你好\"}"}
            }
        }"#;
    let event: MessageEvent = serde_json::from_str(raw).expect("event");
    let mut book = PeerBook::default();
    assert!(book.claim_owner("ou_a"));
    assert!(!book.claim_owner("ou_b"), "主人只认第一个发消息的人");
    assert!(book.remember("ou_a", &event));
    let record = book.target("ou_a").expect("record");
    assert_eq!(record.receive_id_type, "open_id");
    assert_eq!(record.receive_id, "ou_a");
    assert_eq!(record.last_message_id.as_deref(), Some("om-1"));
}

#[test]
fn reconnect_delay_caps_at_one_minute() {
    assert_eq!(reconnect_delay(0), Duration::from_secs(1));
    assert_eq!(reconnect_delay(4), Duration::from_secs(16));
    assert_eq!(reconnect_delay(20), RECONNECT_MAX_DELAY);
}

/* ===== 长连接：对本地 mock WS 服务器跑完整一轮 ===== */

/// mock 服务端：推一条消息事件帧 → 校验回执（同 SeqID、code 200）→ 推一条他人的消息 → 断开。
async fn spawn_feishu_server() -> String {
    use futures_util::StreamExt;

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
        let event_frame = |seq: u64, peer: &str, chat: &str, text: &str| {
            let payload = serde_json::json!({
                "header": { "event_id": format!("e-{seq}"), "event_type": MESSAGE_EVENT },
                "event": {
                    "sender": { "sender_id": { "open_id": peer } },
                    "message": {
                        "message_id": format!("om-{seq}"),
                        "chat_id": chat,
                        "chat_type": "p2p",
                        "message_type": "text",
                        "content": serde_json::json!({ "text": text }).to_string(),
                    }
                }
            })
            .to_string();
            Frame {
                seq_id: seq,
                log_id: seq,
                service: 1,
                method: 1,
                headers: vec![
                    ("type".into(), "event".into()),
                    ("message_id".into(), format!("m-{seq}")),
                    ("sum".into(), "1".into()),
                    ("seq".into(), "0".into()),
                ],
                payload: payload.into_bytes(),
                ..Default::default()
            }
            .encode()
        };

        let _ = socket
            .send(Message::Binary(
                event_frame(1, "ou_owner", "oc-1", "帮我看看今天的安排").into(),
            ))
            .await;
        if let Some(Ok(message)) = socket.next().await {
            let raw = match message {
                Message::Binary(bytes) => bytes.to_vec(),
                Message::Text(text) => text.as_bytes().to_vec(),
                _ => Vec::new(),
            };
            let ack = Frame::decode(&raw).expect("ack frame");
            assert_eq!(ack.seq_id, 1, "回执必须落在同一个 SeqID 上");
            assert_eq!(ack.header("type"), Some("event"), "回执要继承原帧 headers");
            let payload: serde_json::Value =
                serde_json::from_slice(&ack.payload).expect("ack payload");
            assert_eq!(payload["code"], 200);
        }
        let _ = socket
            .send(Message::Binary(
                event_frame(2, "ou_stranger", "oc-2", "外人的消息").into(),
            ))
            .await;
        let _ = socket.next().await;
        let _ = socket.close(None).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    });
    format!("ws://{addr}")
}

#[tokio::test]
async fn stream_once_acks_events_and_filters_foreign_senders() {
    let url = spawn_feishu_server().await;
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
        stream_once(&url, Duration::from_secs(30), &deps, &inner, false),
    )
    .await
    .expect("连接应自行结束")
    .expect("连接不应报错");
    assert_eq!(end, StreamEnd::Closed);

    let inbound: Vec<serde_json::Value> = events
        .lock()
        .iter()
        .filter(|(event, _)| event == INBOUND_EVENT)
        .map(|(_, payload)| payload.clone())
        .collect();
    assert_eq!(inbound.len(), 1, "默认只放行归属人：{inbound:?}");
    assert_eq!(inbound[0]["peerId"], "ou_owner");
    assert_eq!(inbound[0]["text"], "帮我看看今天的安排");
    assert_eq!(inbound[0]["messageId"], "om-1");

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

    let book = persisted.lock().clone().expect("联系人档案应落盘");
    assert_eq!(book.owner.as_deref(), Some("ou_owner"));
    assert_eq!(
        book.target("ou_owner")
            .map(|record| record.receive_id.as_str()),
        Some("ou_owner")
    );
}

/* ===== 扫码创建应用：对本地 mock HTTP 服务器跑完整一轮 ===== */

/// 服务端真实形状的 begin 响应（`expires_in` 带 s、`interval` 单位是秒）。
const BEGIN_BODY: &str = r#"{"device_code":"v1:abc.def","verification_uri_complete":"https://open.feishu.cn/page/launcher?user_code=LF7S-N6L6","verification_uri":"https://open.feishu.cn/page/launcher","user_code":"LF7S-N6L6","expires_in":3600,"interval":5}"#;

/// 按脚本逐条应答的极简 HTTP 服务端（每连接一条请求，`Connection: close`），
/// 请求原文记录下来供断言表单字段。
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

#[test]
fn form_body_percent_encodes_values() {
    // device_code 是带 `:` `-` 的 JWT 串，编码错了服务端只会回 invalid_grant。
    assert_eq!(
        form_body(&[("action", "poll"), ("device_code", "v1:a b")]),
        "action=poll&device_code=v1%3Aa+b"
    );
}

#[tokio::test]
async fn begin_registration_uses_official_form_and_builds_qr_link() {
    let (base, recorded) = spawn_registration_mock(vec![(200, BEGIN_BODY)]).await;
    let client = crate::http::shared_client(5).expect("client");
    let (session, dto) = begin_registration(&client, &base).await.expect("begin");

    assert_eq!(dto.user_code, "LF7S-N6L6");
    assert_eq!(
        dto.expires_in, 3600,
        "服务端给的是 expires_in，不能落到兜底 600s"
    );
    assert_eq!(dto.interval, 5);
    assert!(dto.qr_url.contains("user_code=LF7S-N6L6"));
    for marker in ["from=sdk", "tp=sdk", "source=greywork"] {
        assert!(
            dto.qr_url.contains(marker),
            "二维码链接缺 {marker}: {}",
            dto.qr_url
        );
    }
    assert_eq!(session.interval, Duration::from_secs(5));
    assert!(
        session.expires_at > now_ms() + 3_500_000,
        "有效期应按 expires_in 推算"
    );

    let sent = recorded.lock().join("\n");
    for field in [
        "action=begin",
        "archetype=PersonalAgent",
        "auth_method=client_secret",
        "request_user_info=open_id",
    ] {
        assert!(sent.contains(field), "表单缺字段 {field}: {sent}");
    }
}

#[tokio::test]
async fn poll_registration_reads_flow_state_from_http_400_body() {
    // 这个接口把「还没确认」表达成 HTTP 400 + JSON 体：4xx 不能当传输失败。
    let (base, recorded) = spawn_registration_mock(vec![
        (200, BEGIN_BODY),
        (
            400,
            r#"{"error":"authorization_pending","error_description":"","code":20094}"#,
        ),
    ])
    .await;
    let client = crate::http::shared_client(5).expect("client");
    let (mut session, _) = begin_registration(&client, &base).await.expect("begin");

    let outcome = poll_registration(&client, &mut session)
        .await
        .expect("poll");
    assert_eq!(outcome, PollOutcome::Pending);
    assert_eq!(session.interval, Duration::from_secs(5), "等待中不改间隔");
    assert_eq!(session.domain, base, "国内租户不换域");

    let sent = recorded.lock().join("\n");
    assert!(sent.contains("action=poll"), "轮询要带 action=poll: {sent}");
    assert!(
        sent.contains("device_code=v1%3Aabc.def"),
        "device_code 要按表单编码回传: {sent}"
    );
}

#[tokio::test]
async fn poll_registration_slows_down_and_switches_domain_once() {
    let (base, _) = spawn_registration_mock(vec![
        (200, BEGIN_BODY),
        (400, r#"{"error":"slow_down"}"#),
        (200, r#"{"user_info":{"tenant_brand":"lark"}}"#),
        (200, r#"{"user_info":{"tenant_brand":"lark"}}"#),
    ])
    .await;
    let client = crate::http::shared_client(5).expect("client");
    let (mut session, _) = begin_registration(&client, &base).await.expect("begin");
    assert_eq!(session.domain, base);

    assert_eq!(
        poll_registration(&client, &mut session)
            .await
            .expect("poll"),
        PollOutcome::Pending
    );
    assert_eq!(
        session.interval,
        Duration::from_secs(10),
        "slow_down 要放慢到 5+5 秒"
    );

    assert_eq!(
        poll_registration(&client, &mut session)
            .await
            .expect("poll"),
        PollOutcome::Pending
    );
    assert_eq!(session.domain, ACCOUNTS_LARK_DOMAIN, "国际版租户换域重试");

    // 再报一次 lark 就按普通等待处理：不能在两个域之间来回撞。
    // （把域指回 mock：这一步只验「不再切换」，不该真的去打国际版域名。）
    session.domain = base.clone();
    assert_eq!(
        poll_registration(&client, &mut session)
            .await
            .expect("poll"),
        PollOutcome::Pending
    );
    assert_eq!(session.domain, base, "已经切过域就不再切");
}

#[tokio::test]
async fn poll_registration_returns_credentials_when_confirmed() {
    let (base, _) = spawn_registration_mock(vec![
            (200, BEGIN_BODY),
            (
                200,
                r#"{"client_id":"cli_scan","client_secret":"sec_scan","user_info":{"tenant_brand":"feishu"}}"#,
            ),
        ])
        .await;
    let client = crate::http::shared_client(5).expect("client");
    let (mut session, _) = begin_registration(&client, &base).await.expect("begin");
    assert_eq!(
        poll_registration(&client, &mut session)
            .await
            .expect("poll"),
        PollOutcome::Done {
            app_id: "cli_scan".into(),
            app_secret: "sec_scan".into(),
        }
    );
}

#[test]
fn classify_poll_covers_every_server_error_code() {
    let cases = [
        (
            r#"{"error":"access_denied","error_description":"用户取消"}"#,
            PollOutcome::Denied("用户取消".into()),
        ),
        // 服务端不给描述时留空串：界面出本地化文案
        (
            r#"{"error":"expired_token"}"#,
            PollOutcome::Expired(String::new()),
        ),
        (
            r#"{"error":"invalid_grant","error_description":"device_code is invalid"}"#,
            PollOutcome::Expired("device_code is invalid".into()),
        ),
        (
            r#"{"error":"invalid_client"}"#,
            PollOutcome::Failed("invalid_client".into()),
        ),
        (r#"{}"#, PollOutcome::Pending),
    ];
    for (raw, expected) in cases {
        let response: PollResponse = serde_json::from_str(raw).expect("poll json");
        assert_eq!(classify_poll(&response), expected, "{raw}");
    }

    // 拿到凭证时 lark 也算成功（换域只是重试手段）
    let done: PollResponse = serde_json::from_str(
        r#"{"client_id":"a","client_secret":"b","user_info":{"tenant_brand":"lark"}}"#,
    )
    .expect("json");
    assert_eq!(
        classify_poll(&done),
        PollOutcome::Done {
            app_id: "a".into(),
            app_secret: "b".into(),
        }
    );

    // 空说明不往界面上丢空提示
    assert_eq!(PollOutcome::Denied(String::new()).detail(), None);
    assert_eq!(PollOutcome::Expired("  ".into()).detail(), None);
    assert_eq!(
        PollOutcome::Failed("invalid_client".into())
            .detail()
            .as_deref(),
        Some("invalid_client")
    );
    assert_eq!(
        PollOutcome::Done {
            app_id: "a".into(),
            app_secret: "b".into(),
        }
        .state(),
        "done"
    );
}
