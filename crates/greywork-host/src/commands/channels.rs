//! 聊天通道命令（wechat/dingtalk/feishu/telegram/discord/qq/wecom + 媒体）
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! channels_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- wechat ----
    { "wechat_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_status(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_login_qr", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_login_qr(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_login_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_login_poll(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_login_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_login_cancel(&ctx.wechat).await.map(Json) } }
    { "wechat_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { wechat::wechat_connect(Arc::clone(&ctx.host), &ctx.wechat, a.allow_other_senders).await.map(Json) } }
    { "wechat_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_disconnect(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_logout", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wechat::wechat_logout(Arc::clone(&ctx.host), &ctx.wechat).await.map(Json) } }
    { "wechat_send", auth: Auth::Required, desktop: false, binary: false,
        args: wechat::SendArgs,
        run: |ctx, a| async move { wechat::wechat_send(Arc::clone(&ctx.host), &ctx.wechat, a.to_user_id, a.context_token, a.text).await.map(Json) } }
    { "wechat_send_typing", auth: Auth::Required, desktop: false, binary: false,
        args: wechat::SendTypingArgs,
        run: |ctx, a| async move { wechat::wechat_send_typing(Arc::clone(&ctx.host), &ctx.wechat, a.to_user_id, a.typing).await.map(Json) } }

    // ---- channel_media ----
    { "channel_take_media", auth: Auth::Required, desktop: false, binary: true,
        args: channel_media::TakeMediaArgs,
        run: |ctx, a| async move { channel_media::channel_take_media(ctx.host.as_ref(), a.channel, a.path).map(Bin) } }
    { "channel_send_media", auth: Auth::Required, desktop: false, binary: false,
        args: channel_media::SendMediaArgs,
        run: |ctx, a| async move { channel_send_media(ctx, a).await.map(Json) } }
    { "channel_media_capabilities", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |_ctx, _a| async move { Ok::<_, String>(Json(channel_media::channel_media_capabilities())) } }

    // ---- dingtalk ----
    { "dingtalk_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_status(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: ClientSecretArg,
        run: |ctx, a| async move { dingtalk::dingtalk_save_credentials(Arc::clone(&ctx.host), &ctx.dingtalk, a.client_id, a.client_secret).await.map(Json) } }
    { "dingtalk_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_clear_credentials(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_register_begin", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_register_begin(&ctx.dingtalk).await.map(Json) } }
    { "dingtalk_register_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_register_poll(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_register_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_register_cancel(&ctx.dingtalk).await.map(Json) } }
    { "dingtalk_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { dingtalk::dingtalk_connect(Arc::clone(&ctx.host), &ctx.dingtalk, a.allow_other_senders).await.map(Json) } }
    { "dingtalk_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { dingtalk::dingtalk_disconnect(Arc::clone(&ctx.host), &ctx.dingtalk).await.map(Json) } }
    { "dingtalk_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { dingtalk::dingtalk_send(Arc::clone(&ctx.host), &ctx.dingtalk, a.peer_id, a.text).await.map(Json) } }

    // ---- feishu ----
    { "feishu_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_status(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: AppSecretArg,
        run: |ctx, a| async move { feishu::feishu_save_credentials(Arc::clone(&ctx.host), &ctx.feishu, a.app_id, a.app_secret).await.map(Json) } }
    { "feishu_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_clear_credentials(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_register_begin", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_register_begin(&ctx.feishu).await.map(Json) } }
    { "feishu_register_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_register_poll(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_register_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_register_cancel(&ctx.feishu).await.map(Json) } }
    { "feishu_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { feishu::feishu_connect(Arc::clone(&ctx.host), &ctx.feishu, a.allow_other_senders).await.map(Json) } }
    { "feishu_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { feishu::feishu_disconnect(Arc::clone(&ctx.host), &ctx.feishu).await.map(Json) } }
    { "feishu_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { feishu::feishu_send(Arc::clone(&ctx.host), &ctx.feishu, a.peer_id, a.text).await.map(Json) } }

    // ---- telegram ----
    { "telegram_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_status(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }
    { "telegram_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: TokenArg,
        run: |ctx, a| async move { telegram::telegram_save_credentials(Arc::clone(&ctx.host), &ctx.telegram, a.token).await.map(Json) } }
    { "telegram_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_clear_credentials(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }
    { "telegram_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { telegram::telegram_connect(Arc::clone(&ctx.host), &ctx.telegram, a.allow_other_senders).await.map(Json) } }
    { "telegram_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_disconnect(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }
    { "telegram_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { telegram::telegram_send(Arc::clone(&ctx.host), &ctx.telegram, a.peer_id, a.text).await.map(Json) } }
    { "telegram_bot_link", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { telegram::telegram_bot_link(Arc::clone(&ctx.host), &ctx.telegram).await.map(Json) } }

    // ---- discord ----
    { "discord_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { discord::discord_status(Arc::clone(&ctx.host), &ctx.discord).await.map(Json) } }
    { "discord_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: TokenArg,
        run: |ctx, a| async move { discord::discord_save_credentials(Arc::clone(&ctx.host), &ctx.discord, a.token).await.map(Json) } }
    { "discord_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { discord::discord_clear_credentials(Arc::clone(&ctx.host), &ctx.discord).await.map(Json) } }
    { "discord_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { discord::discord_connect(Arc::clone(&ctx.host), &ctx.discord, a.allow_other_senders).await.map(Json) } }
    { "discord_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { discord::discord_disconnect(Arc::clone(&ctx.host), &ctx.discord).await.map(Json) } }
    { "discord_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { discord::discord_send(Arc::clone(&ctx.host), &ctx.discord, a.peer_id, a.text).await.map(Json) } }

    // ---- qq ----
    { "qq_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_status(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: AppSecretArg,
        run: |ctx, a| async move { qq::qq_save_credentials(Arc::clone(&ctx.host), &ctx.qq, a.app_id, a.app_secret).await.map(Json) } }
    { "qq_register_begin", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_register_begin(&ctx.qq).await.map(Json) } }
    { "qq_register_poll", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_register_poll(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_register_cancel", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_register_cancel(&ctx.qq).await.map(Json) } }
    { "qq_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_clear_credentials(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { qq::qq_connect(Arc::clone(&ctx.host), &ctx.qq, a.allow_other_senders).await.map(Json) } }
    { "qq_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { qq::qq_disconnect(Arc::clone(&ctx.host), &ctx.qq).await.map(Json) } }
    { "qq_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { qq::qq_send(Arc::clone(&ctx.host), &ctx.qq, a.peer_id, a.text).await.map(Json) } }

    // ---- wecom ----
    { "wecom_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wecom::wecom_status(Arc::clone(&ctx.host), &ctx.wecom).await.map(Json) } }
    { "wecom_save_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: BotSecretArg,
        run: |ctx, a| async move { wecom::wecom_save_credentials(Arc::clone(&ctx.host), &ctx.wecom, a.bot_id, a.secret).await.map(Json) } }
    { "wecom_clear_credentials", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wecom::wecom_clear_credentials(Arc::clone(&ctx.host), &ctx.wecom).await.map(Json) } }
    { "wecom_connect", auth: Auth::Required, desktop: false, binary: false,
        args: ConnectArgs,
        run: |ctx, a| async move { wecom::wecom_connect(Arc::clone(&ctx.host), &ctx.wecom, a.allow_other_senders).await.map(Json) } }
    { "wecom_disconnect", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { wecom::wecom_disconnect(Arc::clone(&ctx.host), &ctx.wecom).await.map(Json) } }
    { "wecom_send", auth: Auth::Required, desktop: false, binary: false,
        args: PeerTextArgs,
        run: |ctx, a| async move { wecom::wecom_send(Arc::clone(&ctx.host), &ctx.wecom, a.peer_id, a.text).await.map(Json) } }

        }
    };
}
pub(crate) use channels_commands;
