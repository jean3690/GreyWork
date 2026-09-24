//! 服务端安全策略：命令黑名单 + 客户端可控参数的夹紧。
//!
//! 冻结的 agent 程序白名单不在这里 —— 它经 `CommandContext.agent_programs` 传给
//! `acp_host::acp_start`（来源是配置，不是 DB）。这里管两件事：
//! 1. 整条命令禁用（黑名单）；
//! 2. 把 `acp_start` / `acp_set_permission_tier` 里客户端可控的沙箱/档位参数改写成配置值。

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
pub const DENIED: &[&str] = &["db_agents_sync"];

pub fn is_denied(command: &str) -> bool {
    DENIED.contains(&command)
}

/// 用服务端策略覆盖客户端可控的沙箱/档位参数。
///
/// - `acp_start`：`sandbox`/`tier` 一律取配置值 —— 否则远端可传 `sandbox="off"` 关掉
///   OS 隔离、或 `tier="full"` 拿到全权。
/// - `acp_set_permission_tier`：同样钉到配置档位，防「先按 read-only 起、再升级 full」。
///
/// 参数非对象（如 `null`）时原样返回 —— 那会让 `dispatch` 的入参解析报错，不静默放行。
pub fn overlay_args(command: &str, mut args: Value, config: &ServerConfig) -> Value {
    let Some(object) = args.as_object_mut() else {
        return args;
    };
    match command {
        "acp_start" => {
            if let Some(sandbox) = &config.sandbox {
                object.insert("sandbox".to_string(), Value::String(sandbox.clone()));
            }
            if let Some(tier) = &config.tier {
                object.insert("tier".to_string(), Value::String(tier.clone()));
            }
        }
        "acp_set_permission_tier" => {
            if let Some(tier) = &config.tier {
                object.insert("tier".to_string(), Value::String(tier.clone()));
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
    fn denied_contains_only_db_agents_sync() {
        assert!(is_denied("db_agents_sync"));
        assert!(!is_denied("db_settings_sync"));
        assert!(!is_denied("db_automations_sync"));
        assert!(!is_denied("acp_start"));
    }

    #[test]
    fn overlay_pins_sandbox_and_tier_for_acp_start() {
        let config = ServerConfig {
            sandbox: Some("fs".to_string()),
            tier: Some("read-only".to_string()),
            ..ServerConfig::default()
        };
        let args = serde_json::json!({
            "agentCmd": "opencode acp",
            "sandbox": "off",
            "tier": "full",
        });
        let out = overlay_args("acp_start", args, &config);
        assert_eq!(out["sandbox"], "fs", "sandbox 应被配置覆盖");
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
