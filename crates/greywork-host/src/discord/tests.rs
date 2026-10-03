use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;
use crate::channel_media::MediaKind;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn peer_id_roundtrip_requires_snowflake() {
    assert_eq!(encode_peer("123"), "dm:123");
    assert_eq!(decode_peer("dm:123"), Some("123".into()));
    assert_eq!(decode_peer("123"), None, "缺少前缀");
    assert_eq!(decode_peer("group:123"), None, "未知前缀");
    assert_eq!(decode_peer("dm:"), None, "空 id");
    assert_eq!(
        decode_peer("dm:12a"),
        None,
        "非数字必须挡住（要拼进 URL 路径）"
    );
    assert_eq!(decode_peer("dm:12/../x"), None, "路径穿越必须挡住");
    assert_eq!(decode_peer(&format!("dm:{}", "9".repeat(21))), None, "超长");
}

#[test]
fn token_shape_requires_three_segments() {
    assert!(is_valid_token("MTIzNDU2.Nzg5MA.abcdefghijklmnop"));
    assert!(!is_valid_token(""), "空");
    assert!(!is_valid_token("MTIzNDU2.Nzg5MA"), "两段");
    assert!(!is_valid_token("MTIz.Nz.a-b_c"), "段太短");
    assert!(!is_valid_token("MTIzNDU2.Nzg5M A.abcdef"), "含空格");
    assert!(!is_valid_token(&"a".repeat(MAX_TOKEN_CHARS + 1)), "超长");
    assert!(
        is_valid_token("  MTIzNDU2.Nzg5MA.abcdefghijklmnop  "),
        "两侧空白容忍"
    );
}

#[test]
fn normalize_private_message_only() {
    let data = json!({
        "id": "111",
        "channel_id": "222",
        "content": "你好",
        "timestamp": "2024-01-02T03:04:05.000000+00:00",
        "author": { "id": "333", "username": "jean", "global_name": "Jean" },
    });
    let inbound = normalize_dispatch("MESSAGE_CREATE", &data, 999).expect("私聊消息");
    assert_eq!(inbound.peer_id, "dm:222");
    assert_eq!(inbound.sender_id, "333");
    assert_eq!(inbound.nick, "Jean", "优先全局名");
    assert_eq!(inbound.text, "你好");
    assert_eq!(inbound.at, 1_704_164_645_000, "RFC3339 转毫秒");
}

#[test]
fn normalize_accepts_attachment_only_and_labels_kinds() {
    let data = json!({
        "id": "111",
        "channel_id": "222",
        "content": "",
        "author": { "id": "333", "username": "jean" },
        "attachments": [
            { "filename": "pic.png", "content_type": "image/png", "size": 10, "url": "https://cdn.example/pic" },
            { "filename": "报表.xlsx", "content_type": "application/vnd.ms-excel", "size": 20, "url": "https://cdn.example/report" },
            { "filename": "clip.mp4", "content_type": "video/mp4", "url": "https://cdn.example/v" },
            { "filename": "note.m4a", "content_type": null, "url": "https://cdn.example/a" },
            { "filename": "no-url.bin", "url": "" },
        ],
    });
    let draft = normalize_dispatch("MESSAGE_CREATE", &data, 1).expect("附件消息也是消息");
    assert_eq!(draft.text, "");
    assert_eq!(draft.media.len(), 4, "无直链的附件丢掉");
    assert_eq!(draft.media[0].kind, MediaKind::Image);
    assert_eq!(draft.media[0].name, "pic.png");
    assert_eq!(draft.media[1].kind, MediaKind::File);
    assert_eq!(draft.media[1].name, "报表.xlsx");
    assert_eq!(draft.media[2].kind, MediaKind::Video, "video/* 按视频");
    assert_eq!(
        draft.media[3].kind,
        MediaKind::Audio,
        "无 mime 时按扩展名判语音"
    );
}

#[test]
fn normalize_rejects_non_private_and_noise() {
    let base = json!({
        "id": "111",
        "channel_id": "222",
        "content": "hi",
        "author": { "id": "333", "username": "jean" },
    });
    assert!(
        normalize_dispatch("READY", &base, 1).is_none(),
        "非消息事件"
    );

    let mut guild = base.clone();
    guild["guild_id"] = json!("444");
    assert!(
        normalize_dispatch("MESSAGE_CREATE", &guild, 1).is_none(),
        "服务器频道不在范围"
    );

    let mut from_bot = base.clone();
    from_bot["author"]["bot"] = json!(true);
    assert!(
        normalize_dispatch("MESSAGE_CREATE", &from_bot, 1).is_none(),
        "别的机器人不答复"
    );

    let mut empty = base.clone();
    empty["content"] = json!("   ");
    assert!(
        normalize_dispatch("MESSAGE_CREATE", &empty, 1).is_none(),
        "附件/贴纸没有正文"
    );

    let mut bad_channel = base.clone();
    bad_channel["channel_id"] = json!("22a");
    assert!(
        normalize_dispatch("MESSAGE_CREATE", &bad_channel, 1).is_none(),
        "非雪花频道 id"
    );

    let mut nameless = base;
    nameless["author"] = json!({ "id": "333" });
    let inbound = normalize_dispatch("MESSAGE_CREATE", &nameless, 5).expect("无用户名仍可");
    assert_eq!(inbound.nick, "333", "展示名回落到用户 id");
    assert_eq!(inbound.at, 5, "缺时间戳用收包时间");
}

#[test]
fn frames_carry_official_fields() {
    let identify = identify_frame("aaa.bbb.ccc", INTENTS_DIRECT_MESSAGES);
    assert_eq!(identify["op"], 2);
    assert_eq!(
        identify["d"]["token"], "aaa.bbb.ccc",
        "identify 不带 Bot 前缀"
    );
    assert_eq!(identify["d"]["intents"], 4096);
    assert!(identify["d"]["properties"].is_object(), "properties 必填");

    let resume = resume_frame("aaa.bbb.ccc", "sess-1", 7);
    assert_eq!(resume["op"], 6);
    assert_eq!(resume["d"]["session_id"], "sess-1");
    assert_eq!(resume["d"]["seq"], 7);

    assert_eq!(heartbeat_frame(Some(9))["d"], 9);
    assert_eq!(heartbeat_frame(None)["d"], serde_json::Value::Null);

    assert_eq!(auth_header("aaa.bbb.ccc"), "Bot aaa.bbb.ccc", "REST 要前缀");
}

#[test]
fn intents_cover_only_direct_messages() {
    assert_eq!(INTENTS_DIRECT_MESSAGES, 4096);
    assert_eq!(INTENTS_DIRECT_MESSAGES, 1 << 12);
    assert_eq!(
        INTENTS_DIRECT_MESSAGES & (1 << 15),
        0,
        "不带 MESSAGE_CONTENT，私聊正文本就豁免"
    );
}

#[test]
fn gateway_url_appends_version_and_encoding() {
    assert_eq!(
        gateway_ws_url("wss://gateway.discord.gg"),
        "wss://gateway.discord.gg/?v=10&encoding=json"
    );
    assert_eq!(
        gateway_ws_url("wss://gateway.discord.gg/"),
        "wss://gateway.discord.gg/?v=10&encoding=json",
        "结尾斜杠不重复"
    );
    assert_eq!(
        gateway_ws_url("wss://resume.example/ws?ticket=1"),
        "wss://resume.example/ws?ticket=1&v=10&encoding=json"
    );
}

#[test]
fn close_codes_map_to_actions() {
    assert_eq!(classify_close(Some(4004)), CloseAction::Fatal, "token 无效");
    assert_eq!(
        classify_close(Some(4014)),
        CloseAction::Fatal,
        "intents 被拒"
    );
    assert_eq!(
        classify_close(Some(4007)),
        CloseAction::Reidentify,
        "seq 失效"
    );
    assert_eq!(classify_close(Some(4009)), CloseAction::Reidentify);
    assert_eq!(
        classify_close(Some(1001)),
        CloseAction::Reidentify,
        "主动关闭"
    );
    assert_eq!(classify_close(Some(4000)), CloseAction::Resume);
    assert_eq!(
        classify_close(Some(4008)),
        CloseAction::Resume,
        "限流后重试"
    );
    assert_eq!(classify_close(None), CloseAction::Resume, "没有关闭码");
    assert!(!close_hint(4004).is_empty());
}

#[test]
fn timestamp_fallback_and_parsing() {
    assert_eq!(parse_timestamp(None, 7), 7);
    assert_eq!(parse_timestamp(Some("not-a-time"), 7), 7);
    assert_eq!(
        parse_timestamp(Some("1970-01-01T00:00:01Z"), 7),
        1000,
        "带 Z 的 RFC3339 也认"
    );
}

#[test]
fn peer_book_owner_policy_gates_other_senders() {
    let mut book = PeerBook::default();
    book.remember("dm:1", "U1", "Jean", 10);
    assert_eq!(book.peers["dm:1"].nick, "Jean");
    assert!(book.claim_owner("U1"));
    assert!(!book.claim_owner("U2"));
    assert!(book.allows("U1", false));
    assert!(!book.allows("U2", false));
    assert!(book.allows("U2", true));
}

#[test]
fn text_clamp_rejects_empty_and_truncates() {
    assert!(clamp_text("   ").is_err());
    let long: String = "字".repeat(MAX_TEXT_CHARS + 5);
    assert_eq!(clamp_text(&long).unwrap().chars().count(), MAX_TEXT_CHARS);
}

/// 本地假网关：验证「hello → identify(intents 正确) → READY → MESSAGE_CREATE → 广播」
/// 这条主链真的跑得通，而不只是各段纯函数各自正确。
#[tokio::test]
async fn gateway_handshake_identifies_and_broadcasts_inbound() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("本地端口");
    let addr = listener.local_addr().expect("端口地址");
    let identify_seen = Arc::new(std::sync::Mutex::new(None));

    let server_witness = identify_seen.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("接受连接");
        let mut socket = tokio_tungstenite::accept_async(stream).await.expect("握手");
        // hello：心跳间隔给足，避免测试期间触发「未收到 ACK」分支。
        let hello = json!({ "op": 10, "d": { "heartbeat_interval": 3000 } });
        socket
            .send(Message::text(hello.to_string()))
            .await
            .expect("发 hello");
        let frame = socket
            .next()
            .await
            .expect("等 identify")
            .expect("identify 帧");
        *server_witness.lock().expect("锁") = Some(frame.into_text().expect("文本帧").to_string());
        let ready = json!({
            "op": 0,
            "s": 1,
            "t": "READY",
            "d": { "session_id": "sess-1", "resume_gateway_url": "wss://resume.example" },
        });
        socket
            .send(Message::text(ready.to_string()))
            .await
            .expect("发 READY");
        let message = json!({
            "op": 0,
            "s": 2,
            "t": "MESSAGE_CREATE",
            "d": {
                "id": "111",
                "channel_id": "222",
                "content": "干活",
                "author": { "id": "333", "username": "jean" },
            },
        });
        socket
            .send(Message::text(message.to_string()))
            .await
            .expect("发消息");
        // 等广播落地再关，避免竞态：客户端读到 Close 就返回了。
        // 明确带 1000：官方的「会话已作废」路径要靠关闭码判定，不带码只能按可 resume 处理。
        tokio::time::sleep(Duration::from_millis(200)).await;
        let close = CloseFrame {
            code: CloseCode::Normal,
            reason: "".into(),
        };
        socket.close(Some(close)).await.ok();
    });

    let events: Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let collector = events.clone();
    let deps = GatewayDeps {
        sink: Arc::new(move |event, payload| {
            collector
                .lock()
                .expect("锁")
                .push((event.to_string(), payload));
        }),
        persist: Arc::new(|_peers: &PeerBook| {}),
        allow_other_senders: false,
        inbox: None,
    };
    let inner = Mutex::new(Inner::default());

    let ended = gateway_once(
        &gateway_ws_url(&format!("ws://{addr}")),
        "MTIzNDU2Nzg5.GxYzAb.abcdefghij",
        &deps,
        &inner,
    )
    .await
    .expect("本地网关应正常收尾");
    server.await.expect("服务端任务");

    let identify: serde_json::Value = serde_json::from_str(
        identify_seen
            .lock()
            .expect("锁")
            .as_deref()
            .expect("应当 identify"),
    )
    .expect("identify 是 JSON");
    assert_eq!(identify["op"], 2);
    assert_eq!(identify["d"]["intents"], 4096, "只申请 DIRECT_MESSAGES");
    assert_eq!(
        identify["d"]["token"], "MTIzNDU2Nzg5.GxYzAb.abcdefghij",
        "identify 不带 Bot 前缀"
    );

    let (channel, inbound) = {
        let guard = events.lock().expect("锁");
        let inbound = guard
            .iter()
            .find(|(event, _)| event == INBOUND_EVENT)
            .expect("应广播入站消息")
            .clone();
        (inbound.0, inbound.1)
    };
    assert_eq!(channel, "discord://inbound");
    assert_eq!(inbound["peerId"], "dm:222");
    assert_eq!(inbound["senderId"], "333");
    assert_eq!(inbound["text"], "干活");

    // 连接期间状态广播过 connected，界面据此点亮徽章。
    assert!(
        events
            .lock()
            .expect("锁")
            .iter()
            .any(|(event, payload)| event == STATE_EVENT && payload["state"] == "connected"),
        "应广播 connected 状态"
    );
    // 1000 是「会话已作废」：不能拿去 resume，必须丢掉。
    assert_eq!(ended, GatewayEnd::Reconnect, "对端关闭后重连");
    assert!(
        inner.lock().await.session_id.is_none(),
        "1000 关闭后会话作废"
    );
}

#[test]
fn bot_display_name_falls_back_to_username() {
    let mut user = BotUser {
        id: "1".into(),
        username: "greywork".into(),
        global_name: None,
    };
    assert_eq!(user.display_name(), "greywork");
    user.global_name = Some("  ".into());
    assert_eq!(user.display_name(), "greywork", "空白全局名不算");
    user.global_name = Some("GreyWork".into());
    assert_eq!(user.display_name(), "GreyWork");
}
