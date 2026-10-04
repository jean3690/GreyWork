use super::*;

/// 检索：把 query 取向量，与内存索引暴力余弦，返回 top-K。
pub async fn rag_search(
    embedder: &dyn Embedder,
    db: &Db,
    rag: &RagHost,
    args: SearchArgs,
) -> Result<Vec<RagHit>, String> {
    let query = args.query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if args.base_url.trim().is_empty() || args.model.trim().is_empty() {
        return Err("base_url and model are required".to_string());
    }
    let result = embedder
        .embed(EmbedArgs {
            base_url: args.base_url.trim().to_string(),
            model: args.model.trim().to_string(),
            api_key_env: args.api_key_env,
            headers: args.headers,
            input: vec![query.to_string()],
        })
        .await?;
    let Some(query_vec) = result.embeddings.into_iter().next() else {
        return Ok(Vec::new());
    };

    let index = rag.load(db)?;
    let top_k = args.top_k.unwrap_or(6).clamp(1, 50);
    let mut scored: Vec<RagHit> = index
        .iter()
        .map(|row| RagHit {
            path: row.path.clone(),
            chunk_index: row.chunk_index,
            text: row.text.clone(),
            score: cosine(&query_vec, &row.vec),
        })
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored.truncate(top_k);
    Ok(scored)
}

/// 余弦相似度；维度不符或零向量返回 0。
pub(super) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for index in 0..a.len() {
        dot += a[index] * b[index];
        norm_a += a[index] * a[index];
        norm_b += b[index] * b[index];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}
