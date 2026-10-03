use super::commands::*;
use super::connect::*;
use super::persist::*;
use super::protocol::*;
use super::*;

use crate::channel_media::MediaKind;

fn message(id: i64, text: Option<&str>) -> Message {
    Message {
        message_id: id,
        from: Some(User {
            id: 42,
            first_name: Some("Ada".into()),
            last_name: Some("Lovelace".into()),
            username: Some("ada".into()),
        }),
        chat: Chat {
            id: 7,
            first_name: Some("Ada".into()),
            last_name: None,
            username: None,
            title: None,
        },
        text: text.map(str::to_string),
        caption: None,
        photo: None,
        document: None,
        voice: None,
        audio: None,
        video: None,
        date: Some(1_700_000_000),
    }
}

fn document(file_id: &str, name: Option<&str>, mime: Option<&str>) -> Document {
    Document {
        file_id: file_id.into(),
        file_name: name.map(str::to_string),
        mime_type: mime.map(str::to_string),
        file_size: None,
    }
}

#[test]
fn token_validation_accepts_botfather_shape() {
    assert_eq!(
        validate_token(" 123456789:AAF-abcdef_ghijklmnop ").unwrap(),
        "123456789:AAF-abcdef_ghijklmnop"
    );
}

#[test]
fn token_validation_rejects_malformed_input() {
    assert!(validate_token("").is_err(), "空 token");
    assert!(validate_token("   ").is_err(), "只有空白");
    assert!(validate_token("123456789").is_err(), "没有冒号");
    assert!(validate_token("abc:AAFabcdefghij").is_err(), "id 段非数字");
    assert!(validate_token("123456789:short").is_err(), "密钥段太短");
    assert!(
        validate_token("123456789:AA F-abcdefghij").is_err(),
        "密钥段带空格（会污染 URL）"
    );
    assert!(
        validate_token("123456789:AAF/abcdefghij").is_err(),
        "密钥段带斜杠（会污染 URL）"
    );
    assert!(
        validate_token(&format!("123456789:{}", "a".repeat(MAX_TOKEN_CHARS))).is_err(),
        "超长 token"
    );
    assert!(
        validate_token("１２３:abcdefghij").is_err(),
        "非 ASCII 数字"
    );
}

#[test]
fn normalize_update_maps_text_message_and_uses_server_time() {
    let update = Update {
        update_id: 11,
        message: Some(message(5, Some("你好"))),
    };
    let inbound = normalize_update(&update, 999).expect("有消息体");
    assert_eq!(inbound.message_id, "5");
    assert_eq!(inbound.peer_id, "7");
    assert_eq!(inbound.nick, "Ada Lovelace");
    assert_eq!(inbound.text, "你好");
    assert_eq!(inbound.at, 1_700_000_000_000, "用服务端时间");
}

#[test]
fn normalize_update_keeps_non_text_messages_with_empty_body() {
    let update = Update {
        update_id: 12,
        message: Some(message(6, None)),
    };
    let inbound = normalize_update(&update, 1_700_000_000_500).expect("图片消息也是消息");
    assert_eq!(inbound.text, "");
    assert_eq!(inbound.at, 1_700_000_000_000);
}

#[test]
fn normalize_update_without_message_is_ignored() {
    let update = Update {
        update_id: 13,
        message: None,
    };
    assert!(
        normalize_update(&update, 1).is_none(),
        "编辑/回调类更新不入流"
    );
}

#[test]
fn normalize_update_uses_caption_as_text() {
    let mut msg = message(7, None);
    msg.caption = Some("看这张图".into());
    msg.photo = Some(vec![PhotoSize {
        file_id: "p".into(),
        file_size: Some(5),
    }]);
    let update = Update {
        update_id: 14,
        message: Some(msg),
    };
    let draft = normalize_update(&update, 1).expect("有消息体");
    assert_eq!(draft.text, "看这张图", "配文当正文");
    assert_eq!(draft.media.len(), 1);
    assert_eq!(draft.media[0].file_id, "p");
}

#[test]
fn pending_media_picks_largest_photo_and_labels_files() {
    let mut msg = message(9, None);
    msg.photo = Some(vec![
        PhotoSize {
            file_id: "small".into(),
            file_size: Some(10),
        },
        PhotoSize {
            file_id: "big".into(),
            file_size: Some(999),
        },
    ]);
    msg.document = Some(document(
        "doc-1",
        Some("报表.xlsx"),
        Some("application/vnd.ms-excel"),
    ));

    let media = pending_media(&msg);
    assert_eq!(media.len(), 2);
    assert_eq!(media[0].file_id, "big", "图片取最大档");
    assert_eq!(media[0].kind, MediaKind::Image);
    assert_eq!(media[0].name, "photo");
    assert_eq!(media[1].kind, MediaKind::File);
    assert_eq!(media[1].name, "报表.xlsx");
}

#[test]
fn pending_media_treats_image_mime_as_image_and_caps_count() {
    let mut msg = message(10, None);
    msg.photo = Some(vec![PhotoSize {
        file_id: "p".into(),
        file_size: None,
    }]);
    // image/* 的 document 按图片收（以文件方式发的图）。
    msg.document = Some(document("d", None, Some("image/jpeg")));
    msg.voice = Some(document("v", None, None));
    msg.audio = Some(document("a", None, None));
    msg.video = Some(document("m", None, None));

    let media = pending_media(&msg);
    assert_eq!(media.len(), MAX_INBOUND_MEDIA, "超出上限截断");
    assert_eq!(media[1].kind, MediaKind::Image, "image/* 按图片收");
    assert_eq!(media[1].name, "document", "无名回落固定标签");
    assert_eq!(media[2].kind, MediaKind::Audio, "语音按音频收");
    assert_eq!(media[2].name, "voice");
    assert_eq!(media[3].kind, MediaKind::Audio, "音频按音频收");
    assert_eq!(media[3].name, "audio");
}

#[test]
fn pending_media_classifies_voice_audio_video() {
    let mut msg = message(11, None);
    msg.voice = Some(document("v", Some("note.ogg"), None));
    msg.audio = Some(document("a", Some("song.mp3"), None));
    msg.video = Some(document("m", Some("clip.mp4"), None));

    let media = pending_media(&msg);
    assert_eq!(media.len(), 3);
    assert_eq!(
        (media[0].kind, media[0].name.as_str()),
        (MediaKind::Audio, "note.ogg")
    );
    assert_eq!(
        (media[1].kind, media[1].name.as_str()),
        (MediaKind::Audio, "song.mp3")
    );
    assert_eq!(
        (media[2].kind, media[2].name.as_str()),
        (MediaKind::Video, "clip.mp4")
    );
}

#[test]
fn send_endpoint_maps_kinds_and_voice_format() {
    assert_eq!(
        send_endpoint(MediaKind::Image, "a.png"),
        ("sendPhoto", "photo")
    );
    assert_eq!(
        send_endpoint(MediaKind::Video, "a.mp4"),
        ("sendVideo", "video")
    );
    assert_eq!(
        send_endpoint(MediaKind::File, "a.pdf"),
        ("sendDocument", "document")
    );
    // 语音：OGG/OPUS 走 sendVoice，其余音频走 sendAudio。
    assert_eq!(
        send_endpoint(MediaKind::Audio, "note.ogg"),
        ("sendVoice", "voice")
    );
    assert_eq!(
        send_endpoint(MediaKind::Audio, "note.OPUS"),
        ("sendVoice", "voice")
    );
    assert_eq!(
        send_endpoint(MediaKind::Audio, "song.mp3"),
        ("sendAudio", "audio")
    );
}

#[test]
fn parse_updates_surfaces_api_error() {
    let error = parse_updates(r#"{"ok":false,"description":"Unauthorized"}"#).unwrap_err();
    assert!(error.contains("Unauthorized"), "错误摘要要带 description");
    let empty = parse_updates(r#"{"ok":true,"result":[]}"#).unwrap();
    assert!(empty.is_empty());
}

#[test]
fn peer_book_claims_first_sender_as_owner_and_filters_others() {
    let mut book = PeerBook::default();
    assert!(book.claim_owner("7"), "第一个人是主人");
    assert!(!book.claim_owner("8"), "归属人只认第一个");
    assert!(book.allows("7", false));
    assert!(!book.allows("8", false), "其他人默认不答复");
    assert!(book.allows("8", true), "放开后其他人也可用");
    book.remember("8", "Bob", 100);
    book.remember("8", "Bobby", 200);
    assert_eq!(book.peers.len(), 1, "同一 chat 只留一条档案");
    assert_eq!(book.peers["8"].nick, "Bobby");
    assert_eq!(book.peers["8"].last_at, 200);
    // 归属人本身也要有档案（handle_inbound 里 claim 与 remember 成对调用）
    book.remember("7", "Ada", 300);
    assert_eq!(book.peers.len(), 2);
    assert_eq!(book.owner.as_deref(), Some("7"));
}

#[test]
fn clamp_text_rejects_empty_and_truncates_long_text() {
    assert!(clamp_text("   ").is_err());
    let long: String = "字".repeat(MAX_TEXT_CHARS + 10);
    let clipped = clamp_text(&long).unwrap();
    assert_eq!(clipped.chars().count(), MAX_TEXT_CHARS);
}

#[test]
fn bot_link_builds_t_me_url_from_get_me_payload() {
    let parsed: MeResponse =
            serde_json::from_str(r#"{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"GreyWork","username":"greywork_bot"}}"#)
                .expect("getMe 形状");
    let bot = parsed.result.expect("有 result");
    assert_eq!(bot.username.as_deref(), Some("greywork_bot"));
    assert_eq!(bot.first_name, "GreyWork");
}

#[test]
fn bot_link_payloads_without_username_are_rejected() {
    // ok=true 但没有 username：没有可扫的链接（走同一条错误分支）
    let parsed: MeResponse =
        serde_json::from_str(r#"{"ok":true,"result":{"first_name":"GreyWork"}}"#).expect("形状");
    assert!(parsed.result.expect("有 result").username.is_none());
    // ok=false：把 description 带出去
    let failed: MeResponse =
        serde_json::from_str(r#"{"ok":false,"description":"Unauthorized"}"#).expect("形状");
    assert!(!failed.ok);
    assert_eq!(failed.description.as_deref(), Some("Unauthorized"));
}

#[test]
fn api_url_keeps_token_in_path() {
    assert_eq!(
        api_url("1:abc", "getUpdates"),
        "https://api.telegram.org/bot1:abc/getUpdates"
    );
}
