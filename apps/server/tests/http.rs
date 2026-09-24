//! HTTP 集成测试：用 `tower::ServiceExt::oneshot` 直接驱动路由，不起真实端口。

mod common;

use axum::http::{header, StatusCode};
use serde_json::{json, Value};

use common::{
    command_req, get, harness, harness_with, json_body, login, post_json, send, with_bearer,
    with_cookie, PASSWORD,
};
use greywork_host::db::AgentProviderDto;

#[tokio::test]
async fn health_is_open_without_auth() {
    let h = harness("health");
    let (status, _, body) = send(&h.router, get("/api/health")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_body(&body)["status"], "ok");
}

#[tokio::test]
async fn login_sets_http_only_cookie() {
    let h = harness("login");
    let (status, headers, body) = send(
        &h.router,
        post_json("/api/login", json!({ "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(json_body(&body)["token"].is_string());
    let cookie = headers
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(cookie.contains("gw_session="));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
}

#[tokio::test]
async fn login_with_wrong_password_is_unauthorized() {
    let h = harness("login-wrong");
    let (status, _, _) = send(
        &h.router,
        post_json("/api/login", json!({ "password": "nope" })),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn command_requires_auth() {
    let h = harness("cmd-auth");
    let (status, _, _) = send(&h.router, command_req("db_settings_load", Value::Null)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn command_accepts_cookie_and_bearer_equivalently() {
    let h = harness("cmd-creds");
    let token = login(&h.router, PASSWORD).await;

    let (cookie_status, _, _) = send(
        &h.router,
        with_cookie(command_req("db_settings_load", Value::Null), &token),
    )
    .await;
    assert_eq!(cookie_status, StatusCode::OK);

    let (bearer_status, _, _) = send(
        &h.router,
        with_bearer(command_req("db_settings_load", Value::Null), &token),
    )
    .await;
    assert_eq!(bearer_status, StatusCode::OK);
}

#[tokio::test]
async fn logout_invalidates_session() {
    let h = harness("logout");
    let token = login(&h.router, PASSWORD).await;

    let (status, _, _) = send(
        &h.router,
        with_cookie(post_json("/api/logout", Value::Null), &token),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (after, _, _) = send(
        &h.router,
        with_cookie(command_req("db_settings_load", Value::Null), &token),
    )
    .await;
    assert_eq!(after, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn session_reports_authentication() {
    let h = harness("session");
    let token = login(&h.router, PASSWORD).await;
    let (status, _, body) = send(&h.router, with_cookie(get("/api/session"), &token)).await;
    assert_eq!(status, StatusCode::OK);
    let value = json_body(&body);
    assert_eq!(value["authenticated"], true);
    assert!(value["expiresAt"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn desktop_only_command_is_forbidden() {
    let h = harness("desktop-only");
    let token = login(&h.router, PASSWORD).await;
    let (status, _, body) = send(
        &h.router,
        with_bearer(command_req("sys_info", Value::Null), &token),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(&body).contains("仅桌面端可用"));
}

#[tokio::test]
async fn unknown_command_is_not_found() {
    let h = harness("unknown");
    let token = login(&h.router, PASSWORD).await;
    let (status, _, _) = send(
        &h.router,
        with_bearer(command_req("no_such_command", Value::Null), &token),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn db_agents_sync_is_denied() {
    let h = harness("deny-agents-sync");
    let token = login(&h.router, PASSWORD).await;
    let (status, _, body) = send(
        &h.router,
        with_bearer(
            command_req("db_agents_sync", json!({ "providers": [] })),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(&body).contains("不可用"));
}

#[tokio::test]
async fn settings_round_trips() {
    let h = harness("settings");
    let token = login(&h.router, PASSWORD).await;

    let payload = json!({ "foo": "bar", "n": 3 });
    let (sync_status, _, _) = send(
        &h.router,
        with_bearer(
            command_req("db_settings_sync", json!({ "settings": payload })),
            &token,
        ),
    )
    .await;
    assert_eq!(sync_status, StatusCode::OK);

    let (load_status, _, body) = send(
        &h.router,
        with_bearer(command_req("db_settings_load", Value::Null), &token),
    )
    .await;
    assert_eq!(load_status, StatusCode::OK);
    assert_eq!(json_body(&body), payload);
}

#[tokio::test]
async fn list_commands_exposes_metadata() {
    let h = harness("commands-meta");
    let token = login(&h.router, PASSWORD).await;
    let (status, _, body) = send(&h.router, with_bearer(get("/api/commands"), &token)).await;
    assert_eq!(status, StatusCode::OK);
    let value = json_body(&body);
    let commands = value.as_array().unwrap();
    assert_eq!(commands.len(), 139, "命令总数应与共享表一致");
    let binary: Vec<&str> = commands
        .iter()
        .filter(|meta| meta["binary"] == true)
        .map(|meta| meta["name"].as_str().unwrap())
        .collect();
    assert_eq!(binary, vec!["channel_take_media", "fs_read_binary"]);
}

#[tokio::test]
async fn fs_list_dir_respects_authorized_roots() {
    let h = harness("fs-roots");
    let token = login(&h.router, PASSWORD).await;

    let (ok_status, _, _) = send(
        &h.router,
        with_bearer(
            command_req("fs_list_dir", json!({ "path": h.root().to_string_lossy() })),
            &token,
        ),
    )
    .await;
    assert_eq!(ok_status, StatusCode::OK, "默认根应已授权");

    let outside = h.tmp.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let (denied_status, _, _) = send(
        &h.router,
        with_bearer(
            command_req("fs_list_dir", json!({ "path": outside.to_string_lossy() })),
            &token,
        ),
    )
    .await;
    assert_eq!(denied_status, StatusCode::BAD_REQUEST, "未授权路径应被拒");
}

#[tokio::test]
async fn configured_workspace_root_is_authorized() {
    let mut extra_path = std::path::PathBuf::new();
    let h = harness_with("pre-seed", |config, tmp| {
        let extra = tmp.join("extra");
        std::fs::create_dir_all(&extra).unwrap();
        config.workspace_roots = vec![extra.clone()];
        extra_path = extra;
    });
    let token = login(&h.router, PASSWORD).await;

    let (status, _, _) = send(
        &h.router,
        with_bearer(
            command_req(
                "fs_list_dir",
                json!({ "path": extra_path.to_string_lossy() }),
            ),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "配置预置的根应已授权");
}

#[tokio::test]
async fn fs_read_binary_returns_octet_stream() {
    let h = harness("fs-binary");
    let token = login(&h.router, PASSWORD).await;

    let file = h.root().join("blob.dat");
    let bytes: Vec<u8> = (0..=255u8).collect();
    std::fs::write(&file, &bytes).unwrap();

    let (status, headers, body) = send(
        &h.router,
        with_bearer(
            command_req("fs_read_binary", json!({ "path": file.to_string_lossy() })),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/octet-stream"
    );
    assert_eq!(headers.get("x-greywork-binary").unwrap(), "1");
    assert_eq!(body, bytes);
}

#[tokio::test]
async fn frozen_allowlist_ignores_db_enabled_programs() {
    let h = harness_with("frozen", |config, _| {
        config.sandbox = Some("off".to_string());
    });
    // 模拟「DB 被写入了启用的自配后端」：直写 DB，绕过被禁的 db_agents_sync。
    h.state
        .ctx
        .db
        .sync_agent_providers(&[AgentProviderDto {
            id: "custom-1".to_string(),
            name: "Frozen Test Agent".to_string(),
            kind: "acp".to_string(),
            command: "gw-frozen-test-agent acp".to_string(),
            enabled: true,
            env: None,
        }])
        .unwrap();
    let token = login(&h.router, PASSWORD).await;

    // 配置白名单为空 → DB 里的程序不得放行。
    let (status, _, body) = send(
        &h.router,
        with_bearer(
            command_req(
                "acp_start",
                json!({ "agentCmd": "gw-frozen-test-agent acp" }),
            ),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        String::from_utf8_lossy(&body).contains("not in the allowed list"),
        "应被白名单拒绝，实际: {}",
        String::from_utf8_lossy(&body)
    );
}

#[tokio::test]
async fn configured_allowlist_permits_program() {
    let h = harness_with("allowlisted", |config, _| {
        config.sandbox = Some("off".to_string());
        config.agent_programs = vec!["gw-allowlisted-test-agent".to_string()];
    });
    let token = login(&h.router, PASSWORD).await;

    // 配置放行后应越过白名单校验，失败点变成「起不来进程」而不是「不在白名单」。
    let (status, _, body) = send(
        &h.router,
        with_bearer(
            command_req(
                "acp_start",
                json!({ "agentCmd": "gw-allowlisted-test-agent acp" }),
            ),
            &token,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let text = String::from_utf8_lossy(&body);
    assert!(
        !text.contains("not in the allowed list"),
        "配置放行后不应再被白名单拒绝: {text}"
    );
}

#[tokio::test]
async fn login_throttles_after_repeated_failures() {
    let h = harness("throttle");
    for _ in 0..5 {
        let (status, _, _) = send(
            &h.router,
            post_json("/api/login", json!({ "password": "wrong" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // 第 6 次（即使密码正确）应被限流拦下。
    let (status, _, _) = send(
        &h.router,
        post_json("/api/login", json!({ "password": PASSWORD })),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}
