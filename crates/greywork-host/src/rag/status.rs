use super::*;

/// 索引状态（分块数 / 文件数 / 当前 embedding 模型）。
pub fn rag_status(db: &Db) -> Result<RagStatus, String> {
    let (chunks, files) = db.rag_stats()?;
    let model = db.rag_meta_get(META_MODEL)?;
    let dim = db
        .rag_meta_get("rag.embedding.dim")?
        .and_then(|value| value.parse::<i64>().ok());
    Ok(RagStatus {
        chunks,
        files,
        model,
        dim,
    })
}

/// 清空索引与内存缓存。
pub fn rag_clear(db: &Db, rag: &RagHost) -> Result<(), String> {
    db.rag_clear()?;
    rag.invalidate();
    Ok(())
}
