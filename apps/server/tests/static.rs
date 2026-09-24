//! 静态托管（SPA）路由的集成测试：缓存策略、公开访问、无 catch-all。

mod common;

use std::path::{Path, PathBuf};

use axum::http::{header, StatusCode};

use common::{get, harness_with, json_body, send};

/// 造一份最小前端产物目录：index.html + assets/ + 根级杂项文件。
fn make_dist(tmp: &Path) -> PathBuf {
    let dist = tmp.join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(
        dist.join("index.html"),
        r#"<html><body><div id="app"></div></body></html>"#,
    )
    .unwrap();
    std::fs::write(dist.join("assets").join("app.js"), r#"console.log("app")"#).unwrap();
    std::fs::write(dist.join("logo.svg"), r#"<svg></svg>"#).unwrap();
    dist
}

#[tokio::test]
async fn index_is_public_and_no_cache() {
    // 认证是逐 handler 提取器，静态路由不带它 —— 登录表单必须未登录也能加载。
    let h = harness_with("static-index", |config, tmp| {
        config.static_dir = Some(make_dist(tmp));
    });
    let (status, headers, body) = send(&h.router, get("/")).await;
    assert_eq!(status, StatusCode::OK, "未认证也应能拿到 SPA 入口");
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains(r#"id="app""#), "应返回入口 HTML: {body}");
    // 这条断言同时验证：全局 `no-store` 用的是 `or_insert`（没把静态的 no-cache 冲掉）。
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
}

#[tokio::test]
async fn assets_immutable_and_other_static_revalidated() {
    let h = harness_with("static-cache", |config, tmp| {
        config.static_dir = Some(make_dist(tmp));
    });

    // /assets/*：Vite 内容哈希命名 → 永久缓存。
    let (status, headers, body) = send(&h.router, get("/assets/app.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"console.log("app")"#.as_slice());
    let cache = headers[header::CACHE_CONTROL].to_str().unwrap();
    assert!(
        cache.contains("immutable") && cache.contains("31536000"),
        "assets 应可长缓存: {cache}"
    );

    // 其余静态（pdfjs/、logo.svg 等）：可缓存但每次重验证。
    let (status, headers, body) = send(&h.router, get("/logo.svg")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"<svg></svg>"#.as_slice());
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
}

#[tokio::test]
async fn no_spa_catch_all() {
    // 前端是 hash 路由，唯一需要的 HTML 路由就是 `/`；catch-all 会把打错的资源
    // 404 变成 200 + index.html，既污染缓存又掩盖问题。
    let h = harness_with("static-404", |config, tmp| {
        config.static_dir = Some(make_dist(tmp));
    });
    let (status, _, body) = send(&h.router, get("/missing.js")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        !String::from_utf8_lossy(&body).contains(r#"id="app""#),
        "404 不该被 index.html 顶掉"
    );
}

#[tokio::test]
async fn static_router_does_not_pollute_api_cache_policy() {
    // 挂了静态子路由后，/api/* 仍应是 no-store：命令返回值可能含凭据/文件内容。
    let h = harness_with("static-api", |config, tmp| {
        config.static_dir = Some(make_dist(tmp));
    });
    let (status, headers, body) = send(&h.router, get("/api/health")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_body(&body)["status"], "ok");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
}
