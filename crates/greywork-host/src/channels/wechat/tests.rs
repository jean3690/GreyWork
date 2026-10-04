use super::persist::*;
use super::protocol::*;
use super::*;

use crate::channel_media::MediaKind;
use wechatbot::{
    CDNMedia, FileItem, ImageItem, MessageItemType, MessageState, MessageType, TextItem, VoiceItem,
    WireMessage, WireMessageItem,
};

fn text_item(text: &str) -> WireMessageItem {
    WireMessageItem {
        item_type: MessageItemType::Text,
        text_item: Some(TextItem {
            text: text.to_string(),
        }),
        image_item: None,
        voice_item: None,
        file_item: None,
        video_item: None,
        ref_msg: None,
    }
}

fn voice_item(transcript: Option<&str>) -> WireMessageItem {
    WireMessageItem {
        item_type: MessageItemType::Voice,
        text_item: None,
        image_item: None,
        voice_item: Some(VoiceItem {
            media: None,
            encode_type: None,
            text: transcript.map(str::to_string),
            playtime: Some(1200),
        }),
        file_item: None,
        video_item: None,
        ref_msg: None,
    }
}

fn media_ref(param: &str, aes_key: &str) -> CDNMedia {
    CDNMedia {
        encrypt_query_param: param.to_string(),
        aes_key: aes_key.to_string(),
        encrypt_type: Some(1),
        full_url: None,
    }
}

fn image_item(aeskey: Option<&str>, media: Option<CDNMedia>) -> WireMessageItem {
    WireMessageItem {
        item_type: MessageItemType::Image,
        text_item: None,
        image_item: Some(ImageItem {
            media,
            thumb_media: None,
            aeskey: aeskey.map(str::to_string),
            url: None,
            mid_size: None,
            thumb_width: Some(100),
            thumb_height: Some(200),
        }),
        voice_item: None,
        file_item: None,
        video_item: None,
        ref_msg: None,
    }
}

fn file_item(name: Option<&str>, len: Option<&str>, media: Option<CDNMedia>) -> WireMessageItem {
    WireMessageItem {
        item_type: MessageItemType::File,
        text_item: None,
        image_item: None,
        voice_item: None,
        file_item: Some(FileItem {
            media,
            file_name: name.map(str::to_string),
            md5: None,
            len: len.map(str::to_string),
        }),
        video_item: None,
        ref_msg: None,
    }
}

/// 带 CDN 引用的语音条目（无转写文本；用于入站媒体抽取用例）。
fn voice_item_media(media: Option<CDNMedia>) -> WireMessageItem {
    WireMessageItem {
        item_type: MessageItemType::Voice,
        text_item: None,
        image_item: None,
        voice_item: Some(VoiceItem {
            media,
            encode_type: None,
            text: None,
            playtime: Some(1500),
        }),
        file_item: None,
        video_item: None,
        ref_msg: None,
    }
}

fn video_item(media: Option<CDNMedia>, size: Option<i64>) -> WireMessageItem {
    WireMessageItem {
        item_type: MessageItemType::Video,
        text_item: None,
        image_item: None,
        voice_item: None,
        file_item: None,
        video_item: Some(wechatbot::VideoItem {
            media,
            video_size: size,
            play_length: Some(3),
            thumb_media: None,
        }),
        ref_msg: None,
    }
}

/// 组一条「用户发来的」线格式消息（SDK 的解析入口只认 message_type = User）。
fn wire(items: Vec<WireMessageItem>) -> WireMessage {
    WireMessage {
        from_user_id: "user@im.wechat".to_string(),
        to_user_id: "bot@im.bot".to_string(),
        client_id: "c-1".to_string(),
        create_time_ms: 1_700_000_000_000,
        message_type: MessageType::User,
        message_state: MessageState::Finish,
        context_token: "ctx-1".to_string(),
        item_list: items,
    }
}

fn parse(items: Vec<WireMessageItem>) -> IncomingMessage {
    IncomingMessage::from_wire(&wire(items)).expect("用户消息应能解析")
}

/// 带指定 `context_token` 的用户消息（缓存按消息自己的 token 建表）。
fn parse_with_token(items: Vec<WireMessageItem>, token: &str) -> IncomingMessage {
    let mut message = wire(items);
    message.context_token = token.to_string();
    IncomingMessage::from_wire(&message).expect("用户消息应能解析")
}

#[test]
fn trusted_api_base_must_be_https_under_qq_com() {
    assert!(trusted_api_base("https://ilinkai.weixin.qq.com").is_ok());
    assert!(trusted_api_base("https://ilinkai.weixin.qq.com/").is_ok());
    assert!(
        trusted_api_base("http://ilinkai.weixin.qq.com").is_err(),
        "非 https 拒绝"
    );
    assert!(
        trusted_api_base("https://evil.example.com").is_err(),
        "非 qq.com 域拒绝"
    );
    assert!(
        trusted_api_base("https://qq.com.evil.example.com").is_err(),
        "后缀伪装拒绝"
    );
}

#[test]
fn text_of_reads_text_and_voice_transcript() {
    let message = parse(vec![text_item("你好"), voice_item(Some("语音转写"))]);
    assert_eq!(text_of(&message), "你好\n语音转写");
    assert_eq!(item_types_of(&message), vec![1, 3]);
    assert!(has_recognizable_items(&message));
}

#[test]
fn text_of_ignores_media_placeholders_and_video_is_recognizable() {
    // 纯图片：文本必须是空串（SDK 的 `IncomingMessage::text` 会给 "[image]" 占位串）。
    let image_only = parse(vec![image_item(Some("k"), Some(media_ref("p", "k")))]);
    assert_eq!(text_of(&image_only), "");
    assert!(has_recognizable_items(&image_only));

    // 纯视频：无文本，但已可下载 → 认得出（本轮起视频纳入入站媒体）。
    let video_only = parse(vec![video_item(Some(media_ref("p", "k")), Some(3_000_000))]);
    assert!(has_recognizable_items(&video_only));
    assert_eq!(text_of(&video_only), "");
}

#[test]
fn collect_media_picks_all_kinds() {
    let message = parse(vec![
        image_item(Some("img-key"), Some(media_ref("p1", "fallback"))),
        text_item("附带一句"),
        voice_item_media(Some(media_ref("p3", "vk"))),
        file_item(Some("报表.xlsx"), Some("2048"), Some(media_ref("p2", "fk"))),
        video_item(Some(media_ref("p4", "mk")), Some(3_000_000)),
    ]);
    let items = collect_media(&message);
    assert_eq!(items.len(), 4);

    assert_eq!(items[0].kind, MediaKind::Image);
    assert_eq!(items[0].name, "image-0");
    assert_eq!(
        items[0].aes_key.as_deref(),
        Some("img-key"),
        "图片优先用条目自带的 key"
    );

    assert_eq!(items[1].kind, MediaKind::Audio);
    assert_eq!(items[1].name, "voice-2");
    assert!(items[1].aes_key.is_none(), "语音用 media 自带的 key");

    assert_eq!(items[2].kind, MediaKind::File);
    assert_eq!(items[2].name, "报表.xlsx");
    assert_eq!(items[2].declared_size, Some(2048));
    assert!(items[2].aes_key.is_none(), "文件用 media 自带的 key");

    assert_eq!(items[3].kind, MediaKind::Video);
    assert_eq!(items[3].name, "video-4");
    assert_eq!(items[3].declared_size, Some(3_000_000));
}

#[test]
fn collect_media_skips_items_without_cdn_ref() {
    let message = parse(vec![
        image_item(Some("k"), None),
        file_item(Some("x.bin"), None, None),
        voice_item_media(None),
        video_item(None, None),
    ]);
    assert!(collect_media(&message).is_empty());
}

#[test]
fn collect_media_falls_back_to_media_key_and_index_name() {
    let message = parse(vec![image_item(None, Some(media_ref("p", "media-key")))]);
    let items = collect_media(&message);
    assert_eq!(items[0].aes_key.as_deref(), Some("media-key"));

    let unnamed = parse(vec![file_item(None, None, Some(media_ref("p", "k")))]);
    assert_eq!(collect_media(&unnamed)[0].name, "file-0");
}

#[test]
fn token_cache_finds_by_token_and_is_bounded() {
    let handles = test_handles();
    let total = TOKEN_CACHE_LIMIT + 5;
    for index in 0..total {
        let token = format!("ctx-{index}");
        let message = parse_with_token(vec![text_item(&format!("第 {index} 条"))], &token);
        handles.remember_token(&token, &message);
    }
    // 超限后最旧的被挤掉，最新的按 token 取得到。
    assert!(handles.message_for_token("ctx-0").is_none());
    assert!(handles
        .message_for_token(&format!("ctx-{}", total - 1))
        .is_some());
    assert_eq!(
        handles
            .message_for_token(&format!("ctx-{}", total - 1))
            .expect("最新一条")
            .context_token(),
        format!("ctx-{}", total - 1)
    );
    assert!(handles.message_for_token("  ").is_none(), "空 token 不查表");
}

#[test]
fn read_creds_rejects_missing_broken_and_untrusted() {
    let dir = std::env::temp_dir().join(format!("gw-wechat-creds-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let path = dir.join("credentials.json");

    // 文件不存在 = 未登录。
    assert!(read_creds(&path).is_none());

    // 坏 JSON：按未登录处理并把文件删掉（留着只会让下一次登录在 SDK 内部解析失败）。
    std::fs::write(&path, b"{ not json").expect("写坏文件");
    assert!(read_creds(&path).is_none());
    assert!(!path.exists(), "坏凭证应被删除");

    // 登录地址不可信：同样丢弃（否则 token 会被打到任意主机上）。
    std::fs::write(
        &path,
        br#"{"token":"tok","baseUrl":"https://evil.example.com","accountId":"bot","userId":"u"}"#,
    )
    .expect("写不可信凭证");
    assert!(read_creds(&path).is_none());
    assert!(!path.exists(), "不可信凭证应被删除");

    // 正常凭证：读得出来。
    std::fs::write(
            &path,
            br#"{"token":"tok","baseUrl":"https://ilinkai.weixin.qq.com","accountId":"bot@im.bot","userId":"u@im.wechat"}"#,
        )
        .expect("写正常凭证");
    let creds = read_creds(&path).expect("正常凭证可读");
    assert_eq!(creds.account_id, "bot@im.bot");
    assert_eq!(creds.user_id, "u@im.wechat");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 只用于测缓存的最小宿主句柄（不发事件、不落盘）。
fn test_handles() -> HostHandles {
    let (progress, _) = watch::channel(0);
    HostHandles {
        cred_path: PathBuf::from("/tmp/gw-wechat-test/credentials.json"),
        inbox: PathBuf::from("/tmp/gw-wechat-test/inbox"),
        inner: Arc::new(Mutex::new(Inner::default())),
        bot: Arc::new(Mutex::new(None)),
        login: Arc::new(SyncMutex::new(LoginRun::default())),
        progress,
        cache: Arc::new(SyncMutex::new(VecDeque::new())),
        sink: Arc::new(|_, _| {}),
    }
}
