use super::search::*;
use super::walk::*;
use super::*;

#[test]
fn chunk_text_splits_long_text_with_overlap() {
    // 每行 40 字符 × 40 行 = 1600 字符 > CHUNK_CHARS，应切成多块。
    let line = "x".repeat(40);
    let text = (0..40).map(|_| line.clone()).collect::<Vec<_>>().join("\n");
    let chunks = chunk_text(&text);
    assert!(chunks.len() >= 2, "长文本应切成多块: {}", chunks.len());
    // 相邻块重叠：后一块开头 == 前一块末尾的重叠段。
    let lead: String = chunks[1].chars().take(CHUNK_OVERLAP).collect();
    assert!(!lead.is_empty());
    assert!(chunks[0].ends_with(&lead), "前一块应以第二块的开头结尾");
}

#[test]
fn chunk_text_keeps_short_text_in_one_piece() {
    let chunks = chunk_text("hello\nworld\n");
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0], "hello\nworld\n");
    assert!(chunk_text("   \n\n").is_empty());
}

#[test]
fn tail_chars_handles_short_and_multibyte() {
    assert_eq!(tail_chars("abc", 10), "");
    assert_eq!(tail_chars("abcdef", 2), "ef");
    // 按字符而非字节：中文不会被切坏
    assert_eq!(tail_chars("你好世界", 2), "世界");
}

#[test]
fn cosine_matches_expected_values() {
    assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
    assert!((cosine(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-6);
    // 长度不等 / 零向量 → 0
    assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
    assert_eq!(cosine(&[0.0, 0.0], &[1.0, 1.0]), 0.0);
}

#[test]
fn is_indexable_name_filters_extensions_and_known_files() {
    assert!(is_indexable_name("main.rs"));
    assert!(is_indexable_name("README.MD"));
    assert!(is_indexable_name("Dockerfile"));
    assert!(is_indexable_name("Makefile"));
    assert!(!is_indexable_name("photo.png"));
    assert!(!is_indexable_name("binary"));
}

#[test]
fn collect_files_skips_ignored_dirs_and_binaries() {
    let tmp = std::env::temp_dir().join(format!("gw-rag-walk-{}", std::process::id()));
    let root = tmp.join("root");
    std::fs::create_dir_all(root.join("src")).expect("mkdir src");
    std::fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir nm");
    std::fs::write(root.join("src/main.rs"), "fn main() {}").expect("write rs");
    std::fs::write(root.join("node_modules/pkg/index.js"), "x").expect("write ignored");
    std::fs::write(root.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 0]).expect("write png");

    let mut names: Vec<String> = collect_files(&root)
        .into_iter()
        .map(|file| {
            file.path
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    names.sort();
    assert_eq!(names, vec!["src/main.rs"]);
}

#[test]
fn rag_round_trip_persists_and_clears() {
    let db = Db::open_in_memory().expect("db");
    db.rag_replace_file(
        "/root",
        "/root/a.rs",
        10,
        20,
        &[
            RagChunkDto {
                chunk_index: 0,
                text: "第一块".into(),
                vec: vec![1.0, 0.0],
            },
            RagChunkDto {
                chunk_index: 1,
                text: "第二块".into(),
                vec: vec![0.0, 1.0],
            },
        ],
    )
    .expect("insert");
    let rows = db.rag_load_chunks(None).expect("load");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].vec, vec![1.0, 0.0]);
    let (chunks, files) = db.rag_stats().expect("stats");
    assert_eq!((chunks, files), (2, 1));

    // 整体替换：只剩新的一块
    db.rag_replace_file(
        "/root",
        "/root/a.rs",
        11,
        21,
        &[RagChunkDto {
            chunk_index: 0,
            text: "重写".into(),
            vec: vec![0.5, 0.5],
        }],
    )
    .expect("replace");
    assert_eq!(db.rag_load_chunks(None).expect("reload").len(), 1);

    // 统计 + 增量 mtime
    let stats = db.rag_file_stats("/root").expect("file stats");
    assert_eq!(stats.get("/root/a.rs"), Some(&(11, 21)));

    // 清理不在 keep 里的路径
    let pruned = db.rag_prune_files("/root", &[]).expect("prune");
    assert_eq!(pruned, 1);
    assert!(db.rag_load_chunks(None).expect("empty").is_empty());

    db.rag_meta_set(META_MODEL, "bge-m3").expect("meta");
    assert_eq!(
        db.rag_meta_get(META_MODEL).expect("get"),
        Some("bge-m3".into())
    );
    db.rag_clear().expect("clear");
    assert_eq!(db.rag_meta_get(META_MODEL).expect("get2"), None);
}

#[test]
fn rag_status_reports_meta() {
    let db = Db::open_in_memory().expect("db");
    db.rag_meta_set(META_MODEL, "nomic-embed-text")
        .expect("meta");
    db.rag_meta_set("rag.embedding.dim", "768").expect("dim");
    let status = rag_status(&db).expect("status");
    assert_eq!(status.chunks, 0);
    assert_eq!(status.model.as_deref(), Some("nomic-embed-text"));
    assert_eq!(status.dim, Some(768));
}

#[tokio::test]
async fn rag_search_ranks_by_cosine() {
    let db = Db::open_in_memory().expect("db");
    db.rag_replace_file(
        "/root",
        "/root/a.rs",
        1,
        1,
        &[
            RagChunkDto {
                chunk_index: 0,
                text: "near".into(),
                vec: vec![1.0, 0.0],
            },
            RagChunkDto {
                chunk_index: 1,
                text: "far".into(),
                vec: vec![0.0, 1.0],
            },
        ],
    )
    .expect("insert");

    // mock /v1/embeddings 返回与 "near" 同向的查询向量。
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 4096];
                let _ = stream.read(&mut buf).await;
                let body = r#"{"data":[{"embedding":[1,0]}]}"#;
                let wire = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                let _ = stream.write_all(wire.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });

    let rag = RagHost::default();
    let hits = rag_search(
        &crate::llm::LlmEmbedder,
        &db,
        &rag,
        SearchArgs {
            query: "query".into(),
            base_url: format!("http://{addr}/v1"),
            model: "m".into(),
            api_key_env: None,
            headers: None,
            top_k: Some(1),
        },
    )
    .await
    .expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].text, "near");
    assert!((hits[0].score - 1.0).abs() < 1e-6);
}
