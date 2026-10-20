//! 服务端安全策略：命令黑名单 + 客户端可控参数的夹紧。
//!
//! 冻结的 agent 程序白名单不在这里 —— 它经 `CommandContext.agent_programs` 传给
//! `acp_host::acp_start`（来源是配置，不是 DB）。这里管两件事：
//! 1. 整条命令禁用（黑名单）；
//! 2. 把 `acp_start` / `acp_set_permission_tier` / `worktree_provision` 里客户端可控的
//!    沙箱 / 档位 / 准备脚本参数改写成配置值。

use serde_json::Value;

use crate::config::ServerConfig;

/// 服务端禁用的命令。
///
/// 只禁 `db_agents_sync`：它是 agent 程序目录的真源，能写入任意 `command` 且无校验。
/// 冻结白名单（`acp_start` 不再读 DB）后它已不能扩大 spawn 面，但作为纵深仍直接拒绝，
/// 同时让「在服务端改 agent 后端目录」明确不可用。
///
/// 其余 `db_*_sync`（settings / automations / team_runs）保留可写：它们不进入任何
/// 命令执行路径，扩大不了 RCE 面，且是 UI 正常工作的前提。
///
/// **本机可信宿主**（`GREYWORK_TRUSTED_HOST`，见 `ServerConfig::trusted_host`）下整份放开 ——
/// 那正是桌面壳的形态：用户在**自己这台机器**上改 agent 后端目录、把文件拖进来，都是正常操作，
/// 不该被拦；该拦的是「网络另一端的客户端」。开关的语义因此是「客户端与服务端同机且受信」，
/// 不是「服务端更宽松」。
///
/// `fs_authorize_drop_paths` / `fs_authorize_picked_paths`：把渲染端给的路径写进授权账本。
/// 这是授权面唯一的命令入口 —— 不可信部署下它们会变成「任何客户端都能授权任意路径」，与
/// `WorkspaceAuthorizer` 的「只由宿主壳在收到用户动作时调用」直接冲突，所以默认必须关着。
///
/// `shell_run`：终端命令运行器，交给登录 shell 跑任意命令。它刻意**不走** agent 的
/// 白名单 + 元字符校验（那正是终端的用途），因此是比 `acp_start` 更宽的 spawn 面；不可信
/// 部署（网络另一端能连上）下必须关着，否则等于把 RCE 面交给任何拿到会话的客户端。
///
/// `terminal_*`：交互式终端（真 PTY）。比 `shell_run` 更宽（可持续交互、能跑 vim/top 等
/// 任意程序），是同一安全语义下最该关的一组；只有可信本机宿主才放行。
pub const TRUSTED_HOST_ONLY: &[&str] = &[
    "db_agents_sync",
    "fs_authorize_drop_paths",
    "fs_authorize_picked_paths",
    "shell_run",
    "terminal_close",
    "terminal_list",
    "terminal_open",
    "terminal_resize",
    "terminal_shells",
    "terminal_write",
];

pub fn is_denied(command: &str, trusted_host: bool) -> bool {
    !trusted_host && TRUSTED_HOST_ONLY.contains(&command)
}

/// 该命令在**本宿主**是否可调用：非桌面专属且不在黑名单。
///
/// 暴露给 `GET /api/commands`，让渲染端知道「这条命令调了也是 403」—— 此前
/// `TRUSTED_HOST_ONLY` 只活在服务端内存里，`db_agents_sync` 对外报 `desktopOnly:false`，
/// 渲染端无从得知它不可用，只能每次调用失败后自己踩坑。
pub fn is_available(meta: &greywork_host::commands::CommandMeta, trusted_host: bool) -> bool {
    !meta.desktop_only && !is_denied(meta.name, trusted_host)
}

/// 用服务端策略覆盖客户端可控的档位/准备脚本参数。
///
/// - `acp_start`：`tier` 一律取配置值 —— 否则远端可传 `tier="full"` 拿到全权。
/// - `acp_set_permission_tier`：同样钉到配置档位，防「先按 read-only 起、再升级 full」。
/// - `worktree_provision`：`prepare` 按配置档位夹紧 —— 只读档一律 false。否则远端可借
///   provision 执行仓库里的 `.agents/prepare` 脚本，等于绕过只读档拿到任意代码执行。
///
/// 参数非对象（如 `null`）时原样返回 —— 那会让 `dispatch` 的入参解析报错，不静默放行。
pub fn overlay_args(command: &str, mut args: Value, config: &ServerConfig) -> Value {
    let Some(object) = args.as_object_mut() else {
        return args;
    };
    match command {
        "acp_start" => {
            if let Some(tier) = &config.tier {
                object.insert("tier".to_string(), Value::String(tier.clone()));
            }
        }
        "acp_set_permission_tier" => {
            if let Some(tier) = &config.tier {
                object.insert("tier".to_string(), Value::String(tier.clone()));
            }
        }
        "worktree_provision" => {
            if let Some(tier) = &config.tier {
                object.insert("prepare".to_string(), Value::Bool(tier != "read-only"));
            }
        }
        _ => {}
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untrusted_host_denies_exactly_the_trusted_host_commands() {
        for command in TRUSTED_HOST_ONLY {
            assert!(is_denied(command, false), "{command} 不可信时应被拒");
        }
        assert!(!is_denied("db_settings_sync", false));
        assert!(!is_denied("db_automations_sync", false));
        assert!(!is_denied("acp_start", false));
        assert!(!is_denied("fs_list_dir", false));
    }

    #[test]
    fn trusted_host_lifts_the_deny_list() {
        // 可信宿主下整份放行：桌面上「改 agent 后端目录 / 拖放授权路径」是正常操作。
        for command in TRUSTED_HOST_ONLY {
            assert!(!is_denied(command, true), "{command} 可信时应放行");
        }
        assert!(!is_denied("db_settings_sync", true));
        assert!(!is_denied("fs_list_dir", true));
    }

    #[test]
    fn availability_excludes_desktop_only_and_denied() {
        let find = |name: &str| {
            greywork_host::commands::COMMANDS
                .iter()
                .find(|meta| meta.name == name)
                .unwrap()
        };
        assert!(is_available(find("fs_list_dir"), false), "普通命令可用");
        assert!(!is_available(find("reveal_path"), false), "桌面专属不可用");
        assert!(!is_available(find("db_agents_sync"), false), "黑名单不可用");
        // 两个不可用来源必须区分得开：db_agents_sync 不是桌面专属，只是被禁用。
        assert!(!find("db_agents_sync").desktop_only);
        assert!(find("reveal_path").desktop_only);
    }

    #[test]
    fn availability_includes_denied_commands_on_trusted_host() {
        let find = |name: &str| {
            greywork_host::commands::COMMANDS
                .iter()
                .find(|meta| meta.name == name)
                .unwrap()
        };
        assert!(
            is_available(find("db_agents_sync"), true),
            "可信宿主下 agent 目录应可写"
        );
        // 桌面专属与信任无关：它缺的是宿主能力，不是授权。
        assert!(!is_available(find("reveal_path"), true));
    }

    #[test]
    fn overlay_pins_tier_for_acp_start() {
        let config = ServerConfig {
            tier: Some("read-only".to_string()),
            ..ServerConfig::default()
        };
        let args = serde_json::json!({
            "agentCmd": "opencode acp",
            "tier": "full",
        });
        let out = overlay_args("acp_start", args, &config);
        assert_eq!(out["tier"], "read-only", "tier 应被配置覆盖");
        assert_eq!(out["agentCmd"], "opencode acp", "其余参数不动");
    }

    #[test]
    fn overlay_pins_tier_for_set_permission_tier() {
        let config = ServerConfig {
            tier: Some("read-only".to_string()),
            ..ServerConfig::default()
        };
        let out = overlay_args(
            "acp_set_permission_tier",
            serde_json::json!({ "handle": 1, "tier": "full" }),
            &config,
        );
        assert_eq!(out["tier"], "read-only");
        assert_eq!(out["handle"], 1);
    }

    #[test]
    fn overlay_leaves_acp_args_untouched_when_unpinned() {
        // 「不钉」= tier 是 None（本地可信宿主，见 config::apply_trusted_host）：
        // 渲染端选的档位必须原样透传，不被任何覆盖值改写 —— Electron 壳靠这条拿回桌面语义。
        let config = ServerConfig {
            tier: None,
            ..ServerConfig::default()
        };
        let start_args = serde_json::json!({ "agentCmd": "opencode acp", "tier": "full" });
        assert_eq!(
            overlay_args("acp_start", start_args.clone(), &config),
            start_args,
            "不钉时 acp_start 参数应原样透传"
        );

        let tier_args = serde_json::json!({ "handle": 1, "tier": "full" });
        assert_eq!(
            overlay_args("acp_set_permission_tier", tier_args.clone(), &config),
            tier_args,
            "不钉时改档参数应原样透传"
        );
    }

    #[test]
    fn overlay_clamps_prepare_by_tier() {
        let read_only = ServerConfig {
            tier: Some("read-only".to_string()),
            ..ServerConfig::default()
        };
        let out = overlay_args(
            "worktree_provision",
            serde_json::json!({ "source": "/w", "prepare": true }),
            &read_only,
        );
        assert_eq!(out["prepare"], false, "只读档必须夹掉 prepare");
        assert_eq!(out["source"], "/w", "其余参数不动");

        let full = ServerConfig {
            tier: Some("full".to_string()),
            ..ServerConfig::default()
        };
        let out = overlay_args(
            "worktree_provision",
            serde_json::json!({ "source": "/w", "prepare": false }),
            &full,
        );
        assert_eq!(out["prepare"], true, "非只读档放开 prepare");
    }

    #[test]
    fn overlay_leaves_unrelated_commands_untouched() {
        let config = ServerConfig::default();
        let args = serde_json::json!({ "path": "/x", "tier": "full" });
        assert_eq!(overlay_args("fs_list_dir", args.clone(), &config), args);
    }

    #[test]
    fn overlay_tolerates_non_object_args() {
        let config = ServerConfig::default();
        assert_eq!(
            overlay_args("acp_start", serde_json::Value::Null, &config),
            serde_json::Value::Null
        );
    }
}
