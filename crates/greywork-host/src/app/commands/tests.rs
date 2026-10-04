use std::path::Path;
use std::sync::Arc;

use serde_json::Value;

use crate::acp_host::AcpHost;
use crate::db::Db;
use crate::dingtalk::DingTalkHost;
use crate::discord::DiscordHost;
use crate::feishu::FeishuHost;
use crate::host::{HostContext, HostPaths};
use crate::llm::LlmHost;
use crate::qq::QqHost;
use crate::rag::RagHost;
use crate::sys;
use crate::telegram::TelegramHost;
use crate::wechat::WechatHost;
use crate::wecom::WecomHost;
use crate::workspace_fs::WorkspaceFsAccess;

use super::*;

/// headless 侧的桩宿主：只提供路径，事件/通知丢弃。
struct StubHost {
    paths: HostPaths,
}

impl HostContext for StubHost {
    fn paths(&self) -> &HostPaths {
        &self.paths
    }
    fn emit(&self, _event: &str, _payload: Value) {}
    fn notify(&self, _title: &str, _body: &str) {}
}

fn test_ctx(tmp: &Path) -> CommandContext {
    let data_dir = tmp.join("data");
    let root = tmp.join("root");
    std::fs::create_dir_all(&data_dir).expect("mkdir data");
    std::fs::create_dir_all(&root).expect("mkdir root");
    let host: Arc<dyn HostContext> = Arc::new(StubHost {
        paths: HostPaths::new(tmp.join("home"), data_dir),
    });
    CommandContext {
        host,
        services: Arc::new(Services {
            db: Arc::new(Db::open_in_memory().expect("db")),
            workspace: Arc::new(
                WorkspaceFsAccess::new(&root, tmp.join("access.json")).expect("access"),
            ),
            acp: Arc::new(AcpHost::default()),
            llm: Arc::new(LlmHost::default()),
            rag: Arc::new(RagHost::default()),
        }),
        channels: Arc::new(Channels {
            wechat: Arc::new(WechatHost::default()),
            dingtalk: Arc::new(DingTalkHost::default()),
            feishu: Arc::new(FeishuHost::default()),
            telegram: Arc::new(TelegramHost::default()),
            discord: Arc::new(DiscordHost::default()),
            qq: Arc::new(QqHost::default()),
            wecom: Arc::new(WecomHost::default()),
        }),
        // 空列表 = 只放行内置白名单（headless 语义）。
        agent_programs: Arc::new(Vec::new()),
        // 非空样例：既覆盖「宿主白名单被如实回给渲染端」，也让下面的冒烟断言有东西可断。
        frame_origins: Arc::new(vec!["https://docs.example.com".to_string()]),
        host_facts: sys::HostFacts {
            version: "9.9.9-test".to_string(),
            tray_available: false,
            pinned_sandbox: true,
            pinned_tier: Some("read-only".to_string()),
        },
    }
}

/// 桌面专属命令集合（与计划表一致；漂移测试的另一半在桌面壳）。
const DESKTOP_ONLY: &[&str] = &[
    "browser_back",
    "browser_close",
    "browser_forward",
    "browser_navigate",
    "browser_open",
    "browser_reload",
    "browser_set_bounds",
    "browser_set_visible",
    "browser_stop",
    "reveal_path",
    "open_path",
    "set_unsaved_changes",
    "confirm_exit",
    "plugin_window_open",
    "plugin_window_close",
    "fs_pick_files",
    "pick_workspace_folder",
    "set_close_to_tray",
    "set_tray_labels",
    "close_main_window",
    "open_external",
];

#[test]
fn commands_table_shape() {
    assert_eq!(COMMANDS.len(), 161, "命令总数应为 161");

    // 命令名唯一。
    let mut names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
    names.sort_unstable();
    let unique = {
        let mut n = names.clone();
        n.dedup();
        n.len()
    };
    assert_eq!(unique, names.len(), "命令名必须唯一");

    // 桌面专属集合与计划一致。
    let mut desktop_only: Vec<&str> = COMMANDS
        .iter()
        .filter(|c| c.desktop_only)
        .map(|c| c.name)
        .collect();
    desktop_only.sort_unstable();
    let mut expected = DESKTOP_ONLY.to_vec();
    expected.sort_unstable();
    assert_eq!(desktop_only, expected, "桌面专属集合必须与计划一致");

    // binary 命令恰 3 条。
    let mut binary: Vec<&str> = COMMANDS
        .iter()
        .filter(|c| c.binary)
        .map(|c| c.name)
        .collect();
    binary.sort_unstable();
    assert_eq!(
        binary,
        vec!["channel_take_media", "fs_read_binary", "fs_read_media"]
    );

    // 桌面专属与 binary 不相交。
    assert!(COMMANDS.iter().all(|c| !(c.desktop_only && c.binary)));
}

#[tokio::test]
async fn dispatch_smoke_db_settings_load() {
    let tmp = std::env::temp_dir().join(format!("gw-cmd-smoke-{}", std::process::id()));
    let ctx = test_ctx(&tmp);

    // 端到端：零参命令 + null 载荷。
    let out = dispatch("db_settings_load", Value::Null, &ctx)
        .await
        .expect("dispatch db_settings_load");
    assert!(matches!(out, CommandOutput::Json(Value::Null)));

    // 桌面专属命令明确拒绝。
    let error = dispatch("reveal_path", Value::Null, &ctx)
        .await
        .expect_err("reveal_path 应被拒绝");
    assert!(error.contains("仅桌面端可用"), "实际错误：{error}");

    // sys_info 走得通：宿主侧事实从 ctx 注入，如实回传（服务端不再谎报）。
    let out = dispatch("sys_info", Value::Null, &ctx)
        .await
        .expect("dispatch sys_info");
    let CommandOutput::Json(value) = out else {
        panic!("sys_info 应返回 JSON");
    };
    assert_eq!(value["version"], "9.9.9-test");
    assert_eq!(value["trayAvailable"], serde_json::json!(false));
    assert_eq!(value["pinnedSandbox"], serde_json::json!(true));
    assert_eq!(value["pinnedTier"], serde_json::json!("read-only"));

    // 未知命令。
    assert!(dispatch("no_such_command", Value::Null, &ctx)
        .await
        .is_err());

    // office：零参形态的宿主事实查询经 dispatch 走得通（`office_preview_open`
    // 的端到端在 office.rs 里，那需要真起一个 HTTP 服务）。
    let out = dispatch(
        "office_host_info",
        serde_json::json!({ "envNames": ["GREYWORK_TEST_OFFICE_ABSENT3"] }),
        &ctx,
    )
    .await
    .expect("dispatch office_host_info");
    let CommandOutput::Json(value) = out else {
        panic!("office_host_info 应返回 JSON");
    };
    assert_eq!(
        value["envMissing"],
        serde_json::json!(["GREYWORK_TEST_OFFICE_ABSENT3"])
    );
    // 回的是注入给 ctx 的那份白名单，不是桌面常量 —— 服务端不再谎报。
    assert_eq!(
        value["embeddableFrameOrigins"],
        serde_json::json!(["https://docs.example.com"])
    );

    let _ = std::fs::remove_dir_all(&tmp);
}
