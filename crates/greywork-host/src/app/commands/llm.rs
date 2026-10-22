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
        run: |ctx, a| async move { llm::llm_chat_start(Arc::clone(&ctx.host), &ctx.services.llm, a.base_url, a.model, a.api_key_env, a.messages, a.reasoning_effort, a.headers, llm::InferenceParams { temperature: a.temperature, max_tokens: a.max_tokens }, a.client_token).await.map(Json) } }
    { "llm_chat_stop", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatStopArgs,
        run: |ctx, a| async move { llm::llm_chat_stop(&ctx.services.llm, a.request_id).await.map(Json) } }
    // 聚合式单轮补全：插件 llm.chat 能力的宿主出口（插件不持凭证，baseUrl / 模型由
    // 渲染端按当前设置解析后传入，模型白名单在 manifest 安装期与前端 broker 双重校验）。
    { "llm_chat_complete", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatCompleteArgs,
        run: |_ctx, a| async move { llm::chat_complete(&a.base_url, &a.model, &a.api_key_env, a.messages, &a.reasoning_effort, &a.headers.unwrap_or_default()).await.map(Json) } }
    // 本机 agent 回合：与 llm_chat_* 同一批事件（llm://event），多两个 kind
    // （llm-tool-call / llm-tool-result）。句柄表与 llm_chat_* 独立 —— agent 回合的
    // 生命周期（十几轮 / 几十分钟）与单轮聊天差一个量级，共用会让 stop 拿错句柄。
    { "llm_agent_start", auth: Auth::Required, desktop: false, binary: false,
        args: llm::AgentStartArgs,
        run: |ctx, a| async move { llm::llm_agent_start(Arc::clone(&ctx.host), &ctx.services.agent, Arc::clone(&ctx.services.workspace), a).await.map(Json) } }
    { "llm_agent_stop", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ChatStopArgs,
        run: |ctx, a| async move { llm::llm_agent_stop(&ctx.services.agent, a.request_id).await.map(Json) } }
    // 模型清单（连通性自检）/ 向量 / 语音转写：本地 OpenAI 兼容服务提供。
    { "llm_list_models", auth: Auth::Required, desktop: false, binary: false,
        args: llm::ListModelsArgs,
        run: |_ctx, a| async move { llm::llm_list_models(a).await.map(Json) } }
    { "llm_embed", auth: Auth::Required, desktop: false, binary: false,
        args: llm::EmbedArgs,
        run: |_ctx, a| async move { llm::llm_embed(a).await.map(Json) } }
    { "llm_transcribe", auth: Auth::Required, desktop: false, binary: false,
        args: llm::TranscribeArgs,
        run: |ctx, a| async move { llm::llm_transcribe(ctx.services.workspace.as_ref(), a).await.map(Json) } }

        }
    };
}
pub(crate) use llm_commands;
