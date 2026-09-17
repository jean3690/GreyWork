//! 宿主自主执行（automation 队列兜底消费）。
//!
//! 架构：到期任务由渲染端单消费循环执行（30s 轮询）；当渲染端整体缺席
//! （webview 崩溃/长忙）时，宿主在本模块直接以默认 LLM 配置跑单轮回合并落库，
//! 任务不再因 60min 窗口过期而丢失。
//!
//! 边界与安全：
//! - **只走 LLM 直连**（无工具/无 ACP/无权限请求面）——无人值守不存在权限裁决问题。
//!   绑定 ACP 后端的任务因此**不由宿主兜底**：换一个执行者跑用户明确指定的后端，
//!   等于悄悄改了任务语义；这类行直接 finish failed，等下个 cron 由应用内执行。
//! - **迟到认领**：只捡 due_at 早于 now-2min 的 pending 行（渲染端 30s 轮询
//!   正常时不可能滞留 2min；2min 也覆盖渲染端短忙）。行级 finish 原子认领
//!   兜底渲染端/宿主毫秒级竞态（重复执行同一 intent 至多一次，无害）。
//! - **单轮语义**：intent 视为完整指令（cron 每次独立执行），不带多轮历史。
//! - 无可用 LLM 配置（settings 未初始化/无供应商）→ finish failed，下个 cron 再试。

use crate::db::{AutomationDueDto, Db};
use crate::llm;
use serde_json::{json, Value};
use std::collections::HashMap;

/// 宿主认领阈值：due 后超过该时长仍未消费视为渲染端缺席。
const STALE_AFTER_MS: i64 = 120_000;
/// 每轮最多执行的积压数（防一次 tick 打爆限流）。
const MAX_CLAIM_PER_TICK: u32 = 3;

/// 单条兜底执行的结果（宿主据此发系统通知）。
pub struct Outcome {
    /// 任务名（通知正文前缀）。
    pub name: String,
    /// 执行是否成功。
    pub ok: bool,
    /// 成功时为回复预览；失败时为错误文案。
    pub detail: String,
}

/// 每轮 tick 调用：捡过期 pending 逐条执行（失败 finish failed，不重试）。
///
/// 返回本轮逐条结果——渲染端缺席时它是用户唯一的感知面，由 `scheduler` 转成
/// 系统通知（本模块不碰 AppHandle，db 单测可以只喂 `&Db` 直接调）。
pub async fn claim_and_run(db: &Db) -> Vec<Outcome> {
    let stale = match db.automation_due_list_stale(STALE_AFTER_MS, MAX_CLAIM_PER_TICK) {
        Ok(items) => items,
        Err(error) => {
            crate::log::error("host-exec", format!("拉取过期队列失败: {error}"));
            return Vec::new();
        }
    };
    let mut outcomes = Vec::with_capacity(stale.len());
    for item in stale {
        let result = run_one(db, &item).await;
        let status = if result.is_ok() { "success" } else { "failed" };
        if let Err(error) = db.automation_due_finish(item.id, status) {
            crate::log::error("host-exec", format!("回执失败 id={}: {error}", item.id));
        }
        let outcome = match result {
            Ok(reply) => {
                crate::log::info(
                    "host-exec",
                    format!("宿主执行完成: {} ({})", item.name, item.task_id),
                );
                Outcome {
                    name: item.name.clone(),
                    ok: true,
                    detail: preview(&reply),
                }
            }
            Err(error) => {
                crate::log::error(
                    "host-exec",
                    format!("宿主执行失败: {} ({}) — {error}", item.name, item.task_id),
                );
                Outcome {
                    name: item.name.clone(),
                    ok: false,
                    detail: error,
                }
            }
        };
        outcomes.push(outcome);
    }
    outcomes
}

/// 通知正文用的回复预览：取首行、按字符截断（中文按字符切，不会切坏 UTF-8）。
fn preview(reply: &str) -> String {
    const MAX_CHARS: usize = 80;
    let first_line = reply.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return "（空回复）".into();
    }
    let mut out: String = first_line.chars().take(MAX_CHARS).collect();
    if first_line.chars().count() > MAX_CHARS {
        out.push('…');
    }
    out
}

/// 执行单条：默认 LLM 配置 → 单轮 chat_complete → 新会话落库 → last_run 回写。
/// 成功返回模型回复全文（供通知预览）。
async fn run_one(db: &Db, item: &AutomationDueDto) -> Result<String, String> {
    if item.acp_provider_id.is_some() {
        return Err("任务绑定 ACP 后端：兜底执行只支持本机模型，需在应用内执行".to_string());
    }
    let settings = db
        .load_settings()?
        .ok_or_else(|| "设置未初始化（无模型配置可执行）".to_string())?;
    let (base_url, model, api_key_env, headers) = default_llm_config(&settings)
        .ok_or_else(|| "默认模型供应商缺 baseUrl/model 配置".to_string())?;

    let now = chrono::Utc::now().timestamp_millis();
    let reply = llm::chat_complete(
        &base_url,
        &model,
        &api_key_env,
        vec![llm::LlmChatMessage {
            role: "user".into(),
            content: serde_json::json!(item.intent.clone()),
        }],
        "auto",
        &headers,
    )
    .await?;

    let user_id = format!("host-u-{now}");
    let assistant_id = format!("host-a-{now}");
    let user_message = json!({
        "id": user_id,
        "role": "user",
        "content": item.intent,
        "ts": now,
    });
    let assistant_message = json!({
        "id": assistant_id,
        "role": "assistant",
        "content": reply,
        "ts": now,
    });
    let conversation_id = format!("host-{now}");
    db.insert_host_execution(
        &conversation_id,
        &item.name,
        None,
        &user_message,
        &assistant_message,
    )?;
    db.automation_mark_last_run(&item.task_id, now)?;
    Ok(reply)
}

/// 从 settings 快照解析默认 LLM 端点：selectedModelProviderId 优先，
/// 回落第一个带 baseUrl+model 的供应商。返回 (base_url, model, api_key_env, headers)。
fn default_llm_config(settings: &Value) -> Option<(String, String, String, HashMap<String, String>)> {
    let providers = settings.get("modelProviders")?.as_array()?;
    let selected = settings
        .get("selectedModelProviderId")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    // 优先 selected；否则第一个可用（enabled 优先于禁用）
    let pick = providers
        .iter()
        .find(|provider| provider.get("id").and_then(|v| v.as_str()) == Some(selected))
        .or_else(|| {
            providers
                .iter()
                .find(|provider| {
                    provider
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                })
                .or_else(|| providers.first())
        })?;
    let base_url = pick.get("baseUrl")?.as_str()?.trim().to_string();
    let model = pick.get("model")?.as_str()?.trim().to_string();
    if base_url.is_empty() || model.is_empty() {
        return None;
    }
    let api_key_env = pick
        .get("apiKeyEnv")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    // 自定义请求头：值里的 {{ENV_VAR}} 占位符由 send_chat_request 解析，这里原样透传
    let headers = pick
        .get("headers")
        .and_then(|value| value.as_object())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect::<HashMap<String, String>>()
        })
        .unwrap_or_default();
    Some((base_url, model, api_key_env, headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings_with(selected: Option<&str>) -> Value {
        json!({
            "selectedModelProviderId": selected,
            "modelProviders": [
                { "id": "local", "name": "Local", "kind": "ollama", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3", "apiKeyEnv": "", "enabled": false },
                { "id": "cloud", "name": "Cloud", "kind": "openai-compatible", "baseUrl": "https://api.example.com/v1", "model": "gpt-x", "apiKeyEnv": "EXAMPLE_KEY", "enabled": true }
            ]
        })
    }

    #[test]
    fn preview_takes_first_line_and_truncates_by_chars() {
        assert_eq!(preview("第一行\n第二行"), "第一行", "只取首行");
        let out = preview(&"あ".repeat(100));
        assert_eq!(out.chars().count(), 81, "80 字 + 省略号");
        assert!(out.ends_with('…'));
    }

    #[test]
    fn preview_empty_reply_is_labelled() {
        assert_eq!(preview(""), "（空回复）");
        assert_eq!(preview("   \n  "), "（空回复）");
    }

    #[test]
    fn default_llm_picks_selected_provider() {
        let settings = settings_with(Some("local"));
        let (base_url, model, api_key_env, headers) = default_llm_config(&settings).expect("config");
        assert_eq!(base_url, "http://127.0.0.1:11434/v1");
        assert_eq!(model, "qwen3");
        assert_eq!(api_key_env, "");
        assert!(headers.is_empty(), "无自定义 headers 时为空表");
    }

    #[test]
    fn default_llm_falls_back_to_enabled_when_selection_missing() {
        let settings = settings_with(None);
        let (_, model, api_key_env, _) = default_llm_config(&settings).expect("config");
        assert_eq!(model, "gpt-x", "回落 enabled 供应商");
        assert_eq!(api_key_env, "EXAMPLE_KEY");
    }

    #[test]
    fn default_llm_carries_custom_headers() {
        let settings = json!({
            "selectedModelProviderId": "gw",
            "modelProviders": [{
                "id": "gw",
                "baseUrl": "https://gw.example.com/v1",
                "model": "m1",
                "headers": { "X-Org": "acme", "X-Bad": 42 }
            }]
        });
        let (_, _, _, headers) = default_llm_config(&settings).expect("config");
        assert_eq!(headers.get("X-Org").map(String::as_str), Some("acme"));
        // 非 string 值被过滤
        assert!(!headers.contains_key("X-Bad"));
    }

    #[test]
    fn default_llm_none_without_providers_or_fields() {
        assert!(default_llm_config(&json!({})).is_none());
        assert!(default_llm_config(&json!({ "modelProviders": [] })).is_none());
        assert!(
            default_llm_config(&json!({
                "modelProviders": [{ "id": "x", "model": "" }]
            }))
            .is_none(),
            "缺 baseUrl/model 视为不可用"
        );
    }
}
