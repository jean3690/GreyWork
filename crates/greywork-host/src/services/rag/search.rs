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
    // 打分只产出 (分数, 行下标)：16 字节/元素、零字符串拷贝 —— 命中 K 条后才 clone。
    let mut scored: Vec<(f32, usize)> = score_all(&query_vec, &index);
    // 降序取前 K：select_nth 把「第 K 大」放到下标 K 位、左侧全不小于它 —— O(n)，
    // 取代全量排序的 O(n log n)。只有超出 K 时才需要划分。
    let take = top_k.min(scored.len());
    if take < scored.len() {
        scored.select_nth_unstable_by(take, |a, b| {
            b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(take);
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored
        .into_iter()
        .map(|(score, idx)| {
            let row = &index.rows[idx];
            RagHit {
                path: row.path.clone(),
                chunk_index: row.chunk_index,
                text: row.text.clone(),
                score,
            }
        })
        .collect())
}

/// 余弦相似度；维度不符或零向量返回 0。
pub(super) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot_prod = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for index in 0..a.len() {
        dot_prod += a[index] * b[index];
        norm_a += a[index] * a[index];
        norm_b += b[index] * b[index];
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot_prod / (norm_a.sqrt() * norm_b.sqrt())
}

/// 给索引里每一行打分，返回 `(分数, 行下标)`。
///
/// 命中 arena 时走**单位向量点积**：query 归一化**一次**，之后每行只有一遍乘加 ——
/// 这正是 arena 的意义（旧写法每行都要重算 query 的模长，并做两次除法）。
///
/// 维度不一致（换过 embedding 模型却没整库重建）或 query 是零向量时退回逐行 [`cosine`]。
/// 两条退化路径的结果与引入 arena 之前逐位一致：
/// - 维度不一致 → arena 里各行的 `vec` 已被抽空，`cosine` 见长度不符返回 0；
///   旧行为同样是「长度不符 → 0」。
/// - 零范数 query → 旧 `cosine` 的 `norm_a == 0.0` 分支返回 0。
pub(super) fn score_all(query: &[f32], index: &RagIndex) -> Vec<(f32, usize)> {
    let norm = query.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        if let Some(arena) = &index.arena {
            if arena.dim == query.len() {
                let unit_query: Vec<f32> = query.iter().map(|v| v / norm).collect();
                return index
                    .rows
                    .iter()
                    .enumerate()
                    .map(|(idx, _)| {
                        let row = &arena.unit[idx * arena.dim..(idx + 1) * arena.dim];
                        (dot(&unit_query, row), idx)
                    })
                    .collect();
            }
        }
    }
    index
        .rows
        .iter()
        .enumerate()
        .map(|(idx, row)| (cosine(query, &row.vec), idx))
        .collect()
}

/// 两个等长向量的点积。
///
/// 4 路展开成 4 个独立累加器：f32 加法不满足结合律，单个 `.sum()` 只能串行累加，
/// 编译器不会（也不该）替你重排浮点加法；拆开之后乘加才有机会被打包成 SIMD 指令。
pub(super) fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let n = a.len().min(b.len());
    let mut acc = [0.0f32; 4];
    let mut i = 0;
    while i + 4 <= n {
        acc[0] += a[i] * b[i];
        acc[1] += a[i + 1] * b[i + 1];
        acc[2] += a[i + 2] * b[i + 2];
        acc[3] += a[i + 3] * b[i + 3];
        i += 4;
    }
    // 先两两合并再收尾：4 个部分和保持到最后一刻，减少依赖链长度。
    let mut total = (acc[0] + acc[1]) + (acc[2] + acc[3]);
    while i < n {
        total += a[i] * b[i];
        i += 1;
    }
    total
}
