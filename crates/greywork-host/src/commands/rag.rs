//! RAG 本地向量检索命令
//!
//! 本域的命令**行宏**：把该域的命令行追加到 `command_table` 的累积列表里。
//! 顺序由 `commands/registry.rs` 的入口链唯一决定（此处不决定前后）。

macro_rules! rag_commands {
    ([$next:ident $($rest:ident)*] $($acc:tt)*) => {
        $next! { [$($rest)*] $($acc)*
    // ---- rag（本地向量检索：授权工作区 → 本地 embedding → SQLite → 暴力余弦） ----
    { "rag_index_build", auth: Auth::Required, desktop: false, binary: false,
        args: rag::IndexBuildArgs,
        run: |ctx, a| async move { rag::rag_index_build(ctx.host.as_ref(), ctx.workspace.as_ref(), &ctx.db, &ctx.rag, &llm::LlmEmbedder, a).await.map(Json) } }
    { "rag_search", auth: Auth::Required, desktop: false, binary: false,
        args: rag::SearchArgs,
        run: |ctx, a| async move { rag::rag_search(&llm::LlmEmbedder, &ctx.db, &ctx.rag, a).await.map(Json) } }
    { "rag_status", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { rag::rag_status(&ctx.db).map(Json) } }
    { "rag_clear", auth: Auth::Required, desktop: false, binary: false,
        args: UnitArgs,
        run: |ctx, _a| async move { rag::rag_clear(&ctx.db, &ctx.rag).map(Json) } }

        }
    };
}
pub(crate) use rag_commands;
