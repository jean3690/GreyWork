//! 本地/远端 LLM 命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! llm_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- llm ----
    { "llm_chat_start", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatStartArgs,
        run: |ctx, a| async move { llm::llm_chat_start(Arc::clone(&ctx.host), &ctx.llm, a.base_url, a.model, a.api_key_env, a.messages, a.reasoning_effort, a.headers, llm::InferenceParams { temperature: a.temperature, max_tokens: a.max_tokens }, a.client_token).await.map(Json) } }
    { "llm_chat_stop", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatStopArgs,
        run: |ctx, a| async move { llm::llm_chat_stop(&ctx.llm, a.request_id).await.map(Json) } }
    // 模型清单（连通性自检）/ 向量 / 语音转写：本地 OpenAI 兼容服务提供。
    { "llm_list_models", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ListModelsArgs,
        run: |_ctx, a| async move { llm::llm_list_models(a).await.map(Json) } }
    { "llm_embed", auth: Auth::Required, desktop: false, binary: false,
        args: llm::EmbedArgs,
        run: |_ctx, a| async move { llm::llm_embed(a).await.map(Json) } }
    { "llm_transcribe", auth: Auth::Required, desktop: false, binary: false,
        args: llm::TranscribeArgs,
        run: |ctx, a| async move { llm::llm_transcribe(ctx.workspace.as_ref(), a).await.map(Json) } }

        }
    };
}
pub(crate) use llm_commands;
