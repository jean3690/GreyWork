use super::walk::*;
use super::*;

/* ===== 命令实现 ===== */

/// 构建（或增量更新）指定授权根的向量索引。
pub async fn rag_index_build(
    host: &dyn HostContext,
    workspace: &dyn WorkspaceFs,
    db: &Db,
    rag: &RagHost,
    embedder: &dyn Embedder,
    args: IndexBuildArgs,
) -> Result<IndexBuildResult, String> {
    let root_path = workspace.resolve_existing(&args.root)?;
    if !root_path.is_dir() {
        return Err("索引根必须是目录".to_string());
    }
    if args.base_url.trim().is_empty() || args.model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    let root = root_path.to_string_lossy().to_string();
    let model = args.model.trim().to_string();

    // embedding 模型换过 → 整库失效（不同模型的向量不可比），除非本来就空。
    let stored_model = db.rag_meta_get(META_MODEL)?;
    let model_changed = stored_model
        .as_deref()
        .is_some_and(|stored| stored != model);
    let force = args.force || model_changed;
    if force {
        db.rag_clear()?;
        rag.invalidate();
    }
    db.rag_meta_set(META_MODEL, &model)?;

    let files = collect_files(&root_path);
    let existing = if force {
        HashMap::new()
    } else {
        db.rag_file_stats(&root)?
    };
    let total = files.len();
    log::info(
        "rag",
        format!("index build root={root} files={total} force={force}"),
    );
    emit_progress(host, 0, total);

    let mut kept: Vec<String> = Vec::with_capacity(total);
    let mut chunk_count = 0usize;
    let mut skipped = 0usize;
    let mut dim = None;
    let mut done = 0usize;

    for file in files {
        let path = file.path.to_string_lossy().to_string();
        kept.push(path.clone());
        done += 1;

        let unchanged = !force
            && existing
                .get(&path)
                .is_some_and(|(mtime, size)| *mtime == file.mtime && *size == file.size as i64);
        if unchanged {
            skipped += 1;
            emit_progress(host, done, total);
            continue;
        }

        match index_one_file(embedder, db, &args, &model, &root, &file).await {
            Ok((chunks, file_dim)) => {
                chunk_count += chunks;
                if file_dim.is_some() {
                    dim = file_dim;
                }
            }
            Err(error) => {
                log::warn("rag", format!("跳过文件 {path}: {error}"));
                // 失败即视为未索引：清掉它的旧行，避免检索命中过期内容。
                let _ = db.rag_replace_file(&root, &path, 0, 0, &[]);
            }
        }
        emit_progress(host, done, total);
    }

    // 清理已删除 / 改名的文件（不在本次遍历集合里的路径）。
    let pruned = db.rag_prune_files(&root, &kept)?;
    if let Some(dim) = dim {
        db.rag_meta_set("rag.embedding.dim", &dim.to_string())?;
    }
    rag.invalidate();

    emit_json(
        host,
        serde_json::json!({
            "kind": "done",
            "files": total,
            "chunks": chunk_count,
            "skipped": skipped,
            "pruned": pruned,
        }),
    );
    Ok(IndexBuildResult {
        files: total,
        chunks: chunk_count,
        skipped,
    })
}

/// 读取 → 分块 → 取向量 → 落库（单文件）。
async fn index_one_file(
    embedder: &dyn Embedder,
    db: &Db,
    args: &IndexBuildArgs,
    model: &str,
    root: &str,
    file: &FileEntry,
) -> Result<(usize, Option<i64>), String> {
    let bytes = std::fs::read(&file.path).map_err(|error| format!("读取失败: {error}"))?;
    let text = crate::text::decode_text_bytes(&bytes);
    let chunks = chunk_text(&text);
    let path = file.path.to_string_lossy().to_string();
    if chunks.is_empty() {
        db.rag_replace_file(root, &path, file.mtime, file.size as i64, &[])?;
        return Ok((0, None));
    }

    let mut rows = Vec::with_capacity(chunks.len());
    let mut dim = None;
    for (batch_index, batch) in chunks.chunks(EMBED_BATCH).enumerate() {
        let result = embedder
            .embed(EmbedArgs {
                base_url: args.base_url.clone(),
                model: model.to_string(),
                api_key_env: args.api_key_env.clone(),
                headers: args.headers.clone(),
                input: batch.to_vec(),
            })
            .await?;
        if result.embeddings.len() != batch.len() {
            return Err(format!(
                "embedding 返回数量与输入不符：{} vs {}",
                result.embeddings.len(),
                batch.len()
            ));
        }
        dim = Some(result.dim as i64);
        for (offset, (text, vec)) in batch.iter().zip(result.embeddings).enumerate() {
            rows.push(RagChunkDto {
                chunk_index: (batch_index * EMBED_BATCH + offset) as i64,
                text: text.clone(),
                vec,
            });
        }
    }
    let count = rows.len();
    db.rag_replace_file(root, &path, file.mtime, file.size as i64, &rows)?;
    Ok((count, dim))
}

/// 发一条 `rag://event`。
fn emit_json(host: &dyn HostContext, payload: serde_json::Value) {
    crate::host::emit_json(host, "rag://event", payload);
}

fn emit_progress(host: &dyn HostContext, done: usize, total: usize) {
    emit_json(
        host,
        serde_json::json!({ "kind": "progress", "done": done, "total": total }),
    );
}
