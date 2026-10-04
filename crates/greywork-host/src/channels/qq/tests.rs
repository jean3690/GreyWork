use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde_json::json;

use crate::channel_media::{MediaKind, OutboundMedia};

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

#[test]
fn peer_id_roundtrip_by_scope() {
    assert_eq!(encode_peer(&ChatScope::C2c, "u1"), "c2c:u1");
    assert_eq!(encode_peer(&ChatScope::Group, "g1"), "group:g1");
    assert_eq!(decode_peer("c2c:u1"), Some((ChatScope::C2c, "u1".into())));
    assert_eq!(
        decode_peer("group:g1"),
        Some((ChatScope::Group, "g1".into()))
    );
    assert_eq!(decode_peer("u1"), None, "缺少范围前缀");
    assert_eq!(decode_peer("dm:u1"), None, "未知前缀");
    assert_eq!(decode_peer("c2c:"), None, "空 openid");
}

#[test]
fn normalize_c2c_message_uses_sender_as_peer() {
    let data = json!({
        "id": "msg-1",
        "content": "你好",
        "timestamp": "1700000000",
        "author": { "user_openid": "USER1" },
    });
    let inbound = normalize_dispatch("C2C_MESSAGE_CREATE", &data, 999).expect("单聊消息");
    assert_eq!(inbound.peer_id, "c2c:USER1");
    assert_eq!(inbound.sender_id, "USER1");
    assert_eq!(inbound.message_id, "msg-1");
    assert_eq!(inbound.text, "你好");
    assert_eq!(inbound.at, 1_700_000_000_000);
}

#[test]
fn normalize_group_message_keeps_group_peer_and_member_sender() {
    let data = json!({
        "id": "msg-2",
        "content": "<@!123> 干活",
        "group_openid": "GROUP1",
        "author": { "member_openid": "MEMBER1" },
    });
    let inbound =
        normalize_dispatch("GROUP_AT_MESSAGE_CREATE", &data, 1_700_000_000_500).expect("群消息");
    assert_eq!(inbound.peer_id, "group:GROUP1", "回发要回群里");
    assert_eq!(inbound.sender_id, "MEMBER1", "归属人按成员判");
    assert_eq!(inbound.at, 1_700_000_000_500, "缺 timestamp 时用收包时间");
}

#[test]
fn normalize_ignores_unknown_events_and_incomplete_payloads() {
    let data = json!({ "id": "msg-3", "author": { "user_openid": "U" } });
    assert!(
        normalize_dispatch("AT_MESSAGE_CREATE", &data, 1).is_none(),
        "频道消息不订阅"
    );
    assert!(normalize_dispatch("READY", &json!({}), 1).is_none());
    assert!(
        normalize_dispatch(
            "C2C_MESSAGE_CREATE",
            &json!({ "author": { "user_openid": "U" } }),
            1
        )
        .is_none(),
        "没有消息 id 无法被动回复"
    );
    assert!(
        normalize_dispatch(
            "GROUP_AT_MESSAGE_CREATE",
            &json!({ "id": "m", "author": {} }),
            1
        )
        .is_none(),
        "群消息缺 group_openid"
    );
}

#[test]
fn peer_book_resets_seq_when_message_changes() {
    let mut book = PeerBook::default();
    book.remember("c2c:U", "m1", 10);
    assert_eq!(book.next_reply("c2c:U"), Some(("m1".into(), 1)));
    assert_eq!(book.next_reply("c2c:U"), Some(("m1".into(), 2)));
    book.remember("c2c:U", "m2", 20);
    assert_eq!(
        book.next_reply("c2c:U"),
        Some(("m2".into(), 1)),
        "新消息序号重置"
    );
    assert_eq!(book.next_reply("c2c:absent"), None, "没凭据就不发");
}

#[test]
fn peer_book_owner_policy_gates_other_senders() {
    let mut book = PeerBook::default();
    assert!(book.claim_owner("U1"));
    assert!(!book.claim_owner("U2"));
    assert!(book.allows("U1", false));
    assert!(!book.allows("U2", false));
    assert!(book.allows("U2", true));
}

#[test]
fn reply_payload_carries_passive_reply_fields() {
    let payload = reply_payload("hi", "msg-1", 3);
    assert_eq!(payload["content"], "hi");
    assert_eq!(payload["msg_type"], 0);
    assert_eq!(payload["msg_id"], "msg-1");
    assert_eq!(payload["msg_seq"], 3);
}

#[test]
fn text_clamp_rejects_empty_and_truncates() {
    assert!(clamp_text("   ").is_err());
    let long: String = "字".repeat(MAX_TEXT_CHARS + 5);
    assert_eq!(clamp_text(&long).unwrap().chars().count(), MAX_TEXT_CHARS);
}

#[test]
fn expires_in_accepts_string_and_number() {
    assert_eq!(parse_expires_in(Some(&json!("7200"))), 7200);
    assert_eq!(parse_expires_in(Some(&json!(1800))), 1800);
    assert_eq!(parse_expires_in(None), 7200);
    assert_eq!(parse_expires_in(Some(&json!("oops"))), 7200);
}

#[test]
fn auth_header_matches_official_format() {
    assert_eq!(auth_header("abc"), "QQBot abc");
}

#[test]
fn intents_cover_only_public_c2c_and_group_events() {
    assert_eq!(INTENTS_PUBLIC_MESSAGES, 33_554_432);
    assert_eq!(INTENTS_PUBLIC_MESSAGES, 1 << 25);
}

/// 按服务端口径加密一份 AppSecret：base64(12B nonce ‖ 密文+tag)，密钥同样 base64。
fn encrypt_secret(secret: &str, key: &[u8; 32], nonce: [u8; 12]) -> String {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), secret.as_bytes())
        .unwrap();
    let mut raw = nonce.to_vec();
    raw.extend_from_slice(&ciphertext);
    BASE64.encode(raw)
}

#[test]
fn decrypt_secret_roundtrips_the_server_encoding() {
    let key = [7u8; 32];
    let bind_key = BASE64.encode(key);
    let encrypted = encrypt_secret("s3cr3t-app-secret", &key, [1u8; 12]);
    assert_eq!(
        decrypt_secret(&encrypted, &bind_key).unwrap(),
        "s3cr3t-app-secret"
    );
}

#[test]
fn decrypt_secret_rejects_wrong_key_and_malformed_payload() {
    let encrypted = encrypt_secret("secret", &[7u8; 32], [2u8; 12]);
    // 换一把密钥：GCM tag 校验失败。
    assert!(decrypt_secret(&encrypted, &BASE64.encode([9u8; 32])).is_err());
    // 密文太短 / 非法 base64。
    assert!(decrypt_secret(&BASE64.encode([0u8; 10]), &BASE64.encode([7u8; 32])).is_err());
    assert!(decrypt_secret("!!!not-base64!!!", &BASE64.encode([7u8; 32])).is_err());
}

#[test]
fn classify_poll_maps_status_and_decrypts_on_completion() {
    let key = [5u8; 32];
    let bind_key = BASE64.encode(key);

    // status 0/1 → 等待。
    assert_eq!(
        classify_poll(&json!({ "status": 0 }), &bind_key),
        PollOutcome::Pending
    );
    assert_eq!(
        classify_poll(&json!({ "status": 1 }), &bind_key),
        PollOutcome::Pending
    );
    // status 3 → 过期。
    assert_eq!(
        classify_poll(&json!({ "status": 3 }), &bind_key),
        PollOutcome::Expired
    );
    // status 2 + 凭证 → 完成，AppSecret 已解密（appid 兼容数字与字符串）。
    let encrypted = encrypt_secret("app-secret", &key, [3u8; 12]);
    assert_eq!(
        classify_poll(
            &json!({ "status": 2, "bot_appid": "102000000", "bot_encrypt_secret": encrypted }),
            &bind_key
        ),
        PollOutcome::Done {
            app_id: "102000000".into(),
            app_secret: "app-secret".into(),
        }
    );
    // 完成却缺字段 → 如实报错（不是静默 pending）。
    assert!(matches!(
        classify_poll(&json!({ "status": 2, "bot_appid": "102000000" }), &bind_key),
        PollOutcome::Failed(_)
    ));
}

#[test]
fn connect_url_encodes_task_id() {
    assert_eq!(
        connect_url("TASK+1/2"),
        "https://q.qq.com/qqbot/openclaw/connect.html?task_id=TASK%2B1%2F2&_wv=2"
    );
}

#[test]
fn bind_envelope_reports_retcode_failures() {
    let failed: BindEnvelope =
        serde_json::from_str(r#"{"retcode":10001,"msg":"注入失败"}"#).unwrap();
    assert!(failed
        .into_data("发起扫码")
        .unwrap_err()
        .contains("注入失败"));

    let ok: BindEnvelope =
        serde_json::from_str(r#"{"retcode":0,"data":{"task_id":"T1"}}"#).unwrap();
    assert_eq!(ok.into_data("发起扫码").unwrap()["task_id"], "T1");
}

#[test]
fn normalize_accepts_attachment_only_and_labels_kinds() {
    let data = json!({
        "id": "msg-9",
        "author": { "user_openid": "U9" },
        "attachments": [
            { "content_type": "image/png", "filename": "图.png", "size": 12, "url": "https://cdn/1" },
            { "content_type": "video/mp4", "filename": "片.mp4", "url": "https://cdn/2" },
            { "content_type": "application/octet-stream", "filename": "声.mp3", "url": "https://cdn/3" },
            { "content_type": "application/octet-stream", "url": "https://cdn/4" },
            { "url": "   " }
        ],
    });
    let inbound = normalize_dispatch("C2C_MESSAGE_CREATE", &data, 1).expect("纯附件消息也要收");
    assert_eq!(inbound.text, "");
    assert_eq!(inbound.media.len(), 4, "空直链的丢掉");
    assert_eq!(inbound.media[0].kind, MediaKind::Image, "image/* 按图片");
    assert_eq!(inbound.media[0].name, "图.png");
    assert_eq!(inbound.media[0].declared_size, Some(12));
    assert_eq!(inbound.media[1].kind, MediaKind::Video, "video/* 按视频");
    assert_eq!(
        inbound.media[2].kind,
        MediaKind::Audio,
        "mime 认不出时按扩展名判语音"
    );
    assert_eq!(inbound.media[3].kind, MediaKind::File, "都认不出按文件");
    assert_eq!(inbound.media[3].name, "attachment", "缺文件名回落");
}

#[test]
fn pending_attachments_caps_at_max() {
    let items: Vec<AttachmentPayload> = (0..(MAX_INBOUND_MEDIA + 3))
        .map(|index| AttachmentPayload {
            url: format!("https://cdn/{index}"),
            ..AttachmentPayload::default()
        })
        .collect();
    assert_eq!(pending_attachments(&items).len(), MAX_INBOUND_MEDIA);
}

#[test]
fn file_type_falls_back_to_file_for_unsupported_images() {
    let png = OutboundMedia {
        bytes: vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
        name: "a.png".into(),
        kind: MediaKind::Image,
    };
    assert_eq!(qq_file_type(&png), FILE_TYPE_IMAGE);
    // 嗅探得出是 gif：QQ 图片只认 png/jpg，降级为文件，免得撞 850019。
    let gif = OutboundMedia {
        bytes: b"GIF89a....".to_vec(),
        name: "a.gif".into(),
        kind: MediaKind::Image,
    };
    assert_eq!(qq_file_type(&gif), FILE_TYPE_FILE);
    let doc = OutboundMedia {
        bytes: b"hello".to_vec(),
        name: "a.txt".into(),
        kind: MediaKind::File,
    };
    assert_eq!(qq_file_type(&doc), FILE_TYPE_FILE);

    // 视频：mp4/mov 走视频（2），其余容器降级为文件。
    let mp4 = OutboundMedia {
        bytes: b"\x00\x00\x00\x18ftypisom".to_vec(),
        name: "clip.mp4".into(),
        kind: MediaKind::Video,
    };
    assert_eq!(qq_file_type(&mp4), FILE_TYPE_MEDIA);
    let mkv = OutboundMedia {
        bytes: vec![0x1a, 0x45, 0xdf, 0xa3],
        name: "clip.mkv".into(),
        kind: MediaKind::Video,
    };
    assert_eq!(qq_file_type(&mkv), FILE_TYPE_FILE);

    // 语音：QQ 要 SILK，共享层已降级为文件（kind 到不了这里，这里兜底也是文件）。
    let voice = OutboundMedia {
        bytes: b"OggS....".to_vec(),
        name: "note.ogg".into(),
        kind: MediaKind::Audio,
    };
    assert_eq!(qq_file_type(&voice), FILE_TYPE_FILE);
}

#[test]
fn digests_match_known_vectors() {
    assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
}

#[test]
fn size_of_accepts_string_and_number() {
    assert_eq!(size_of(&json!("1048576")), Some(1_048_576));
    assert_eq!(size_of(&json!(2048)), Some(2048));
    assert_eq!(size_of(&json!(null)), None);
    assert_eq!(size_of(&json!("oops")), None);
}

#[test]
fn rich_media_payload_uses_msg_type_seven() {
    let payload = rich_media_payload("FILE_INFO", "msg-1", 2);
    assert_eq!(payload["msg_type"], 7);
    assert_eq!(payload["media"]["file_info"], "FILE_INFO");
    assert_eq!(payload["msg_id"], "msg-1");
    assert_eq!(payload["msg_seq"], 2);
}

#[test]
fn resource_urls_split_by_scope() {
    assert_eq!(
        messages_url(&ChatScope::C2c, "U1"),
        format!("{API_BASE}/v2/users/U1/messages")
    );
    assert_eq!(
        messages_url(&ChatScope::Group, "G1"),
        format!("{API_BASE}/v2/groups/G1/messages")
    );
}
