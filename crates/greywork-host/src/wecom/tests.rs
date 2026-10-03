use aes::cipher::generic_array::GenericArray;
use aes::cipher::KeyInit;
use aes::Aes256;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::json;

use crate::channel_media::MediaKind;

use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

#[test]
fn peer_id_roundtrip_by_scope() {
    assert_eq!(encode_peer(&ChatScope::Single, "u1"), "single:u1");
    assert_eq!(encode_peer(&ChatScope::Group, "c1"), "group:c1");
    assert_eq!(
        decode_peer("single:u1"),
        Some((ChatScope::Single, "u1".into()))
    );
    assert_eq!(
        decode_peer("group:c1"),
        Some((ChatScope::Group, "c1".into()))
    );
    assert_eq!(decode_peer("u1"), None);
    assert_eq!(decode_peer("dm:u1"), None);
    assert_eq!(decode_peer("single:"), None);
}

#[test]
fn normalize_single_chat_message() {
    let body = json!({
        "msgid": "MSG1",
        "create_time": 1700000000,
        "chattype": "single",
        "from": { "userid": "zhangsan" },
        "msgtype": "text",
        "text": { "content": "你好" },
    });
    let inbound = normalize_callback(&body, 999).expect("单聊消息");
    assert_eq!(inbound.peer_id, "single:zhangsan");
    assert_eq!(inbound.sender_id, "zhangsan");
    assert_eq!(inbound.text, "你好");
    assert_eq!(inbound.unsupported, "");
    assert_eq!(inbound.at, 1_700_000_000_000);
}

#[test]
fn normalize_group_message_keeps_chatid_as_peer() {
    let body = json!({
        "msgid": "MSG2",
        "chatid": "CHAT1",
        "chattype": "group",
        "from": { "userid": "lisi" },
        "msgtype": "text",
        "text": { "content": "@RobotA 干活" },
    });
    let inbound = normalize_callback(&body, 1_700_000_000_500).expect("群消息");
    assert_eq!(inbound.peer_id, "group:CHAT1", "回发要回群");
    assert_eq!(inbound.sender_id, "lisi", "归属人按发送者判");
    assert_eq!(inbound.at, 1_700_000_000_500, "缺时间戳时用收包时间");
}

#[test]
fn normalize_marks_non_text_and_rejects_incomplete() {
    let image = json!({
        "msgid": "MSG3",
        "chattype": "single",
        "from": { "userid": "u" },
        "msgtype": "image",
    });
    let inbound = normalize_callback(&image, 1).expect("图片消息也要如实转达");
    assert_eq!(inbound.text, "");
    assert_eq!(inbound.unsupported, "image");

    assert!(
        normalize_callback(&json!({ "msgid": "M", "chattype": "single" }), 1).is_none(),
        "缺发送者"
    );
    assert!(
        normalize_callback(
            &json!({ "msgid": "M", "chattype": "group", "from": { "userid": "u" } }),
            1
        )
        .is_none(),
        "群消息缺 chatid 无从回发"
    );
}

#[test]
fn normalize_voice_transcription_becomes_text() {
    // 企业微信语音回调只给转写文本（voice.content），没有可下载音频：当正文转达。
    let body = json!({
        "msgid": "MSGV",
        "chattype": "single",
        "from": { "userid": "zhaoliu" },
        "msgtype": "voice",
        "voice": { "content": "帮我订个明天的会议" },
    });
    let inbound = normalize_callback(&body, 1).expect("语音消息转写成正文");
    assert_eq!(inbound.text, "帮我订个明天的会议", "语音转写当正文");
    assert_eq!(inbound.unsupported, "", "有转写的语音不再标记为不支持");
    assert!(inbound.media.is_empty(), "语音没有可下载媒体");

    // 转写为空（异常）时如实标记不支持，而不是投递空消息。
    let empty = json!({
        "msgid": "MSGV2",
        "chattype": "single",
        "from": { "userid": "zhaoliu" },
        "msgtype": "voice",
        "voice": { "content": "" },
    });
    let inbound = normalize_callback(&empty, 1).expect("空转写仍是一条消息");
    assert_eq!(inbound.unsupported, "voice", "空转写按不支持标记");
}

#[test]
fn frames_carry_required_fields() {
    let subscribe = subscribe_frame("BOT", "SECRET", "req-1");
    assert_eq!(subscribe["cmd"], "aibot_subscribe");
    assert_eq!(subscribe["body"]["bot_id"], "BOT");
    assert_eq!(subscribe["headers"]["req_id"], "req-1");

    let respond = respond_frame("req-2", "hi");
    assert_eq!(respond["cmd"], "aibot_respond_msg");
    assert_eq!(respond["headers"]["req_id"], "req-2", "必须透传回调 req_id");
    assert_eq!(respond["body"]["msgtype"], "text");
    assert_eq!(respond["body"]["text"]["content"], "hi");

    let push = push_frame(&ChatScope::Group, "CHAT1", "hi", "req-3");
    assert_eq!(push["cmd"], "aibot_send_msg");
    assert_eq!(push["body"]["chatid"], "CHAT1");
    assert_eq!(push["body"]["chat_type"], 2);
    assert_eq!(push["body"]["msgtype"], "markdown");
    let push_single = push_frame(&ChatScope::Single, "u1", "hi", "req-4");
    assert_eq!(push_single["body"]["chat_type"], 1);

    assert_eq!(ping_frame("req-5")["cmd"], "ping");
}

#[test]
fn frame_error_reads_errcode() {
    let ok: ServerFrame = serde_json::from_value(json!({ "errcode": 0, "errmsg": "ok" })).unwrap();
    assert!(frame_error(&ok).is_none());
    let missing: ServerFrame = serde_json::from_value(json!({})).unwrap();
    assert!(frame_error(&missing).is_none(), "没有 errcode 视为成功");
    let failed: ServerFrame =
        serde_json::from_value(json!({ "errcode": 40001, "errmsg": "invalid secret" })).unwrap();
    let error = frame_error(&failed).expect("非 0 即错误");
    assert!(error.contains("40001") && error.contains("invalid secret"));
}

#[test]
fn peer_book_tracks_reply_credential_and_owner() {
    let mut book = PeerBook::default();
    book.remember("single:u1", "req-1", 10);
    assert_eq!(book.reply_credential("single:u1").as_deref(), Some("req-1"));
    book.remember("single:u1", "", 20);
    assert_eq!(
        book.reply_credential("single:u1").as_deref(),
        Some("req-1"),
        "空 req_id 不覆盖旧凭据"
    );
    assert_eq!(book.reply_credential("single:u2"), None);

    assert!(book.claim_owner("u1"));
    assert!(!book.claim_owner("u2"));
    assert!(book.allows("u1", false));
    assert!(!book.allows("u2", false));
    assert!(book.allows("u2", true));
}

#[test]
fn text_clamp_rejects_empty_and_truncates() {
    assert!(clamp_text("  ").is_err());
    let long: String = "字".repeat(MAX_TEXT_CHARS + 1);
    assert_eq!(clamp_text(&long).unwrap().chars().count(), MAX_TEXT_CHARS);
}

#[test]
fn req_ids_are_unique_per_call() {
    let a = new_req_id();
    let b = new_req_id();
    assert_ne!(a, b);
    assert!(a.starts_with("gw-"));
}

#[test]
fn ws_url_is_the_official_long_connection_endpoint() {
    assert_eq!(WS_URL, "wss://openws.work.weixin.qq.com");
}

#[test]
fn normalize_extracts_media_from_image_file_and_mixed() {
    let image = json!({
        "msgid": "M1", "chattype": "single", "from": { "userid": "u" },
        "msgtype": "image",
        "image": { "url": "https://cdn/1", "aeskey": "K1" },
    });
    let draft = normalize_callback(&image, 1).expect("图片消息");
    assert_eq!(draft.unsupported, "", "有可下载媒体的消息不算 unsupported");
    assert_eq!(draft.media.len(), 1);
    assert_eq!(draft.media[0].kind, MediaKind::Image);
    assert_eq!(draft.media[0].url, "https://cdn/1");
    assert_eq!(draft.media[0].aeskey.as_deref(), Some("K1"));

    let file = json!({
        "msgid": "M2", "chattype": "single", "from": { "userid": "u" },
        "msgtype": "file",
        "file": { "url": "https://cdn/2", "aeskey": "K2", "name": "报表.pdf", "size": 99 },
    });
    let draft = normalize_callback(&file, 1).expect("文件消息");
    assert_eq!(draft.media.len(), 1);
    assert_eq!(draft.media[0].kind, MediaKind::File);
    assert_eq!(draft.media[0].name, "报表.pdf");
    assert_eq!(draft.media[0].declared_size, Some(99));

    let video = json!({
        "msgid": "M4", "chattype": "single", "from": { "userid": "u" },
        "msgtype": "video",
        "video": { "url": "https://cdn/4", "aeskey": "K4" },
    });
    let draft = normalize_callback(&video, 1).expect("视频消息");
    assert_eq!(draft.media.len(), 1);
    assert_eq!(draft.media[0].kind, MediaKind::Video);

    let mixed = json!({
        "msgid": "M3", "chattype": "single", "from": { "userid": "u" },
        "msgtype": "mixed",
        "mixed": { "msg_item": [
            { "type": "text", "text": { "content": "看这张" } },
            { "type": "image", "image": { "url": "https://cdn/3", "aeskey": "K3" } },
        ] },
    });
    let draft = normalize_callback(&mixed, 1).expect("图文混排");
    assert_eq!(draft.text, "看这张", "图文混排的文本项也当正文");
    assert_eq!(draft.media.len(), 1);
    assert_eq!(draft.media[0].kind, MediaKind::Image);
}

#[test]
fn pending_media_drops_empty_urls_and_caps() {
    let body = CallbackBody {
        image: Some(MediaBlock {
            url: Some("   ".into()),
            aeskey: None,
        }),
        ..CallbackBody::default()
    };
    assert!(pending_media(&body).is_empty(), "空直链丢掉");

    let items: Vec<MixedItem> = (0..(MAX_INBOUND_MEDIA + 2))
        .map(|index| MixedItem {
            kind: Some("image".into()),
            image: Some(MediaBlock {
                url: Some(format!("https://cdn/{index}")),
                aeskey: None,
            }),
            ..MixedItem::default()
        })
        .collect();
    let body = CallbackBody {
        mixed: Some(MixedBlock { msg_item: items }),
        ..CallbackBody::default()
    };
    assert_eq!(pending_media(&body).len(), MAX_INBOUND_MEDIA);
}

/// 按服务端口径加密一份媒体：AES-256-CBC，IV 取密钥前 16 字节，PKCS#7 填充。
fn encrypt_media(plain: &[u8], key: &[u8; 32]) -> Vec<u8> {
    use aes::cipher::BlockEncrypt;
    let cipher = Aes256::new(GenericArray::from_slice(key));
    let pad = 16 - (plain.len() % 16);
    let mut padded = plain.to_vec();
    for _ in 0..pad {
        padded.push(pad as u8);
    }
    let mut prev = [0u8; 16];
    prev.copy_from_slice(&key[..16]);
    let mut out = Vec::with_capacity(padded.len());
    for block in padded.as_chunks::<16>().0 {
        let mut buf = GenericArray::clone_from_slice(block);
        for (index, byte) in buf.iter_mut().enumerate() {
            *byte ^= prev[index];
        }
        cipher.encrypt_block(&mut buf);
        out.extend_from_slice(&buf);
        prev.copy_from_slice(&buf);
    }
    out
}

#[test]
fn decrypt_media_roundtrips_aes_256_cbc() {
    let key = [7u8; 32];
    let encoded = BASE64.encode(key);
    let plain = b"hello wecom media".to_vec();
    let encrypted = encrypt_media(&plain, &key);
    assert_eq!(decrypt_media(&encrypted, &encoded).unwrap(), plain);

    // 真实形状：43 字符、不带 `=` 的 aeskey 也要能解。
    let trimmed = encoded.trim_end_matches('=');
    assert_eq!(trimmed.len(), 43);
    assert_eq!(decrypt_media(&encrypted, trimmed).unwrap(), plain);

    // 密文长度不是 16 的倍数 / 缺密钥 → 报错而不是给出乱码。
    assert!(decrypt_media(&encrypted[..encrypted.len() - 1], &encoded).is_err());
    assert!(decrypt_media(&encrypted, "  ").is_err());
    assert!(
        decrypt_media(&encrypted, &BASE64.encode([9u8; 16])).is_err(),
        "密钥长度不对"
    );
}

#[test]
fn md5_hex_matches_known_vector() {
    assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
}

#[test]
fn media_frames_carry_media_id() {
    let respond = respond_media_frame("req-1", MEDIA_TYPE_IMAGE, "MID");
    assert_eq!(respond["cmd"], "aibot_respond_msg");
    assert_eq!(respond["headers"]["req_id"], "req-1", "必须透传回调 req_id");
    assert_eq!(respond["body"]["msgtype"], "image");
    assert_eq!(respond["body"]["image"]["media_id"], "MID");

    let push = push_media_frame(&ChatScope::Group, "CHAT1", MEDIA_TYPE_IMAGE, "MID", "req-2");
    assert_eq!(push["cmd"], "aibot_send_msg");
    assert_eq!(push["body"]["chatid"], "CHAT1");
    assert_eq!(push["body"]["chat_type"], 2);
    assert_eq!(push["body"]["msgtype"], "image");
    assert_eq!(push["body"]["image"]["media_id"], "MID");
}

#[test]
fn upload_bodies_carry_required_fields() {
    let init = upload_init_body("a.png", MEDIA_TYPE_IMAGE, 1024, 1, "deadbeef");
    assert_eq!(init["filename"], "a.png");
    assert_eq!(init["type"], "image");
    assert_eq!(init["total_size"], 1024);
    assert_eq!(init["total_chunks"], 1);
    assert_eq!(init["md5"], "deadbeef");

    let chunk = upload_chunk_body("UP1", 0, 2, "QUJD");
    assert_eq!(chunk["upload_id"], "UP1");
    assert_eq!(chunk["chunk_index"], 0);
    assert_eq!(chunk["total_chunks"], 2);
    assert_eq!(chunk["base64_data"], "QUJD");

    let finish = upload_finish_body("UP1", "a.png", MEDIA_TYPE_IMAGE);
    assert_eq!(finish["upload_id"], "UP1");
    assert_eq!(finish["filename"], "a.png");
    assert_eq!(finish["media_type"], "image");
}
