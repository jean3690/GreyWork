use super::schema::{migrate, MIGRATIONS};
use super::*;
use rusqlite::{params, Connection};
use serde_json::json;

fn snapshot_with(sessions: Vec<ConversationDto>, active: Option<&str>) -> SessionsSnapshotDto {
    SessionsSnapshotDto {
        sessions,
        active_session_id: active.map(|s| s.to_string()),
    }
}

fn conversation(id: &str, message_count: usize) -> ConversationDto {
    ConversationDto {
        id: id.to_string(),
        title: format!("会话 {id}"),
        workspace_id: Some("ws-1".to_string()),
        created_at: 1_000,
        updated_at: 2_000,
        messages: (0..message_count)
            .map(|i| {
                json!({
                    "id": format!("{id}-m{i}"),
                    "role": if i % 2 == 0 { "user" } else { "assistant" },
                    "content": format!("消息 {i}"),
                    "ts": 1_000 + i as i64,
                    "tools": [ { "toolCallId": format!("t{i}"), "kind": "think" } ],
                })
            })
            .collect(),
    }
}

#[test]
fn migrations_advance_user_version_and_create_tables() {
    let db = Db::open_in_memory().expect("open");
    let conn = db.conn.lock();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MIGRATIONS.len() as i64);
    for table in ["conversations", "messages", "meta"] {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "表 {table} 应存在");
    }
}

#[test]
fn fresh_db_loads_none_until_first_sync() {
    let db = Db::open_in_memory().expect("open");
    assert!(
        db.load_snapshot().unwrap().is_none(),
        "未接管前 load 应为 None"
    );

    db.sync_snapshot(&snapshot_with(vec![], None)).unwrap();
    let loaded = db.load_snapshot().unwrap().expect("接管后 load 应为 Some");
    assert!(loaded.sessions.is_empty());
    assert!(loaded.active_session_id.is_none());
}

#[test]
fn roundtrip_preserves_conversation_and_message_fields() {
    let db = Db::open_in_memory().expect("open");
    let snapshot = snapshot_with(
        vec![conversation("ses-a", 3), conversation("ses-b", 1)],
        Some("ses-b"),
    );
    db.sync_snapshot(&snapshot).unwrap();

    let loaded = db.load_snapshot().unwrap().expect("some");
    assert_eq!(loaded.sessions.len(), 2);
    assert_eq!(loaded.active_session_id.as_deref(), Some("ses-b"));

    let a = loaded.sessions.iter().find(|s| s.id == "ses-a").unwrap();
    assert_eq!(a.title, "会话 ses-a");
    assert_eq!(a.workspace_id.as_deref(), Some("ws-1"));
    assert_eq!(a.created_at, 1_000);
    assert_eq!(a.messages.len(), 3);
    // 消息不透明往返：tools 等扩展字段原样保留
    assert_eq!(a.messages[0]["tools"][0]["toolCallId"], "t0");
    assert_eq!(a.messages[0]["content"], "消息 0");
    assert_eq!(a.messages[2]["role"], "user");
    assert_eq!(a.messages[1]["role"], "assistant");
}

#[test]
fn sync_is_idempotent_and_orders_messages_by_insertion() {
    let db = Db::open_in_memory().expect("open");
    let snapshot = snapshot_with(vec![conversation("ses-a", 3)], Some("ses-a"));
    db.sync_snapshot(&snapshot).unwrap();
    db.sync_snapshot(&snapshot).unwrap(); // 同快照重复同步

    let loaded = db.load_snapshot().unwrap().expect("some");
    assert_eq!(loaded.sessions.len(), 1);
    let a = &loaded.sessions[0];
    assert_eq!(a.messages.len(), 3, "重复同步不得复制消息");
    let ids: Vec<&str> = a.messages.iter().filter_map(|m| m["id"].as_str()).collect();
    assert_eq!(
        ids,
        vec!["ses-a-m0", "ses-a-m1", "ses-a-m2"],
        "消息保持插入序"
    );
}

#[test]
fn sync_removes_vanished_sessions_with_cascade() {
    let db = Db::open_in_memory().expect("open");
    db.sync_snapshot(&snapshot_with(
        vec![conversation("ses-a", 2), conversation("ses-b", 4)],
        Some("ses-a"),
    ))
    .unwrap();
    // 第二次同步少一个会话 → 应整体删除（消息级联）
    db.sync_snapshot(&snapshot_with(
        vec![conversation("ses-a", 2)],
        Some("ses-a"),
    ))
    .unwrap();

    let loaded = db.load_snapshot().unwrap().expect("some");
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].id, "ses-a");
    let orphan: i64 = db
        .conn
        .lock()
        .query_row(
            "SELECT count(*) FROM messages WHERE conversation_id = 'ses-b'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan, 0, "会话删除后消息应级联清除");
}

#[test]
fn active_session_id_roundtrip_and_clear() {
    let db = Db::open_in_memory().expect("open");
    db.sync_snapshot(&snapshot_with(vec![], Some("ses-x")))
        .unwrap();
    assert_eq!(
        db.load_snapshot()
            .unwrap()
            .unwrap()
            .active_session_id
            .as_deref(),
        Some("ses-x")
    );
    db.sync_snapshot(&snapshot_with(vec![], None)).unwrap();
    assert!(db
        .load_snapshot()
        .unwrap()
        .unwrap()
        .active_session_id
        .is_none());
}

#[test]
fn empty_snapshot_after_initialization_stays_empty() {
    // 用户清空全部会话后重启：不得因「空库」回退到种子数据
    let db = Db::open_in_memory().expect("open");
    db.sync_snapshot(&snapshot_with(
        vec![conversation("ses-a", 1)],
        Some("ses-a"),
    ))
    .unwrap();
    db.sync_snapshot(&snapshot_with(vec![], None)).unwrap();
    let loaded = db.load_snapshot().unwrap();
    assert!(loaded.is_some(), "接管后清空仍是真源（Some 空快照）");
    assert!(loaded.unwrap().sessions.is_empty());
}

#[test]
fn settings_load_none_before_first_sync() {
    let db = Db::open_in_memory().expect("open");
    assert!(db.load_settings().unwrap().is_none());
    // settings 不写接管标记：与会话快照互不干扰
    assert!(db.load_snapshot().unwrap().is_none());
}

#[test]
fn settings_roundtrip_preserves_nested_object() {
    let db = Db::open_in_memory().expect("open");
    let settings = json!({
        "theme": "light",
        "modelProviders": [
            { "id": "opencode", "name": "OpenCode", "model": "ling-3.0-flash-fin-free", "enabled": true }
        ],
        "cliIntegrations": [],
        "selectedModelProviderId": null
    });
    db.sync_settings(&settings).unwrap();
    let loaded = db.load_settings().unwrap().expect("some");
    assert_eq!(loaded["theme"], "light");
    assert_eq!(
        loaded["modelProviders"][0]["model"],
        "ling-3.0-flash-fin-free"
    );
    assert!(loaded["selectedModelProviderId"].is_null());
}

#[test]
fn settings_sync_overwrites_previous() {
    let db = Db::open_in_memory().expect("open");
    db.sync_settings(&json!({ "theme": "dark" })).unwrap();
    db.sync_settings(&json!({ "theme": "system" })).unwrap();
    let loaded = db.load_settings().unwrap().expect("some");
    assert_eq!(loaded["theme"], "system");
    assert_eq!(loaded.as_object().unwrap().len(), 1, "整体替换不残留旧键");
}

#[test]
fn migrations_advance_to_v2_with_automation_tasks() {
    let db = Db::open_in_memory().expect("open");
    let conn = db.conn.lock();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MIGRATIONS.len() as i64);
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'automation_tasks'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

fn task(id: &str, cron: Option<&str>, enabled: bool) -> AutomationTaskDto {
    AutomationTaskDto {
        id: id.to_string(),
        name: format!("任务 {id}"),
        schedule: "每天 09:00".to_string(),
        cron: cron.map(|c| c.to_string()),
        once_at: None,
        acp_provider_id: None,
        target: "主仓".to_string(),
        intent: "生成日报".to_string(),
        enabled,
        last_run: 0,
    }
}

#[test]
fn automations_load_none_until_first_sync() {
    let db = Db::open_in_memory().expect("open");
    assert!(db.load_automations().unwrap().is_none());
    db.sync_automations(&[]).unwrap();
    let loaded = db.load_automations().unwrap().expect("接管后 Some");
    assert!(loaded.is_empty(), "接管后空清单 = 用户清空（不复活种子）");
}

#[test]
fn automations_roundtrip_preserves_cron_and_enabled() {
    let db = Db::open_in_memory().expect("open");
    let tasks = vec![
        task("at-1", Some("0 9 * * *"), true),
        task("at-2", None, false), // 手动触发
    ];
    db.sync_automations(&tasks).unwrap();
    let loaded = db.load_automations().unwrap().expect("some");
    assert_eq!(loaded.len(), 2);
    let at1 = loaded.iter().find(|t| t.id == "at-1").unwrap();
    assert_eq!(at1.cron.as_deref(), Some("0 9 * * *"));
    assert!(at1.enabled);
    assert_eq!(at1.name, "任务 at-1");
    let at2 = loaded.iter().find(|t| t.id == "at-2").unwrap();
    assert!(at2.cron.is_none());
    assert!(!at2.enabled);
}

#[test]
fn automations_roundtrip_preserves_once_at_without_cron() {
    // 一次性任务：只有 once_at，没有 cron（cron 没有年份字段，表达不了单次触发）
    let db = Db::open_in_memory().expect("open");
    let mut once = task("at-once", None, true);
    once.once_at = Some(1_800_000_000_000);
    db.sync_automations(std::slice::from_ref(&once)).unwrap();
    let loaded = db.load_automations().unwrap().expect("some");
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].once_at, Some(1_800_000_000_000));
    assert!(loaded[0].cron.is_none());
    // 循环任务仍是 cron 路径：once_at 留空
    let recurring = task("at-daily", Some("0 9 * * *"), true);
    db.sync_automations(&[once, recurring]).unwrap();
    let loaded = db.load_automations().unwrap().expect("some");
    assert!(loaded
        .iter()
        .find(|t| t.id == "at-daily")
        .unwrap()
        .once_at
        .is_none());
}

#[test]
fn automations_sync_removes_vanished_and_updates_last_run() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[
        task("at-1", Some("0 9 * * *"), true),
        task("at-2", None, false),
    ])
    .unwrap();
    // 前端执行完成回写 last_run（同一任务 upsert）
    let mut updated = task("at-1", Some("0 9 * * *"), true);
    updated.last_run = 1_700_000_000_000;
    db.sync_automations(&[updated]).unwrap();
    let loaded = db.load_automations().unwrap().expect("some");
    assert_eq!(loaded.len(), 1, "at-2 消失应被删除");
    assert_eq!(loaded[0].last_run, 1_700_000_000_000);
    assert_eq!(loaded[0].id, "at-1");
}

fn run(id: &str, goal: &str) -> TeamRunDto {
    TeamRunDto {
        id: id.to_string(),
        payload: json!({
            "id": id,
            "goal": goal,
            "status": "done",
            "subtasks": [ { "id": format!("{id}-s1"), "role": "builder", "prompt": goal, "status": "done" } ],
            "createdAt": 1_000,
            "finishedAt": 2_000,
        }),
    }
}

#[test]
fn team_runs_migration_v3_advances_version() {
    let db = Db::open_in_memory().expect("open");
    let conn = db.conn.lock();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MIGRATIONS.len() as i64);
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'team_runs'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn team_runs_load_none_until_first_sync() {
    let db = Db::open_in_memory().expect("open");
    assert!(db.load_team_runs().unwrap().is_none());
    db.sync_team_runs(&[]).unwrap();
    let loaded = db.load_team_runs().unwrap().expect("接管后 Some");
    assert!(loaded.is_empty(), "接管后空存档 = 用户清空");
}

#[test]
fn team_runs_roundtrip_preserves_subtasks_untouched() {
    let db = Db::open_in_memory().expect("open");
    let runs = vec![run("run-1", "生成日报"), run("run-2", "巡检依赖")];
    db.sync_team_runs(&runs).unwrap();
    let loaded = db.load_team_runs().unwrap().expect("some");
    assert_eq!(loaded.len(), 2);
    let run1 = loaded.iter().find(|r| r.id == "run-1").unwrap();
    assert_eq!(run1.payload["goal"], "生成日报");
    assert_eq!(run1.payload["subtasks"][0]["role"], "builder");
    assert_eq!(run1.payload["status"], "done");
    // payload 内 id 与行 id 一致
    assert_eq!(run1.payload["id"], "run-1");
}

#[test]
fn team_runs_sync_upserts_and_removes_vanished() {
    let db = Db::open_in_memory().expect("open");
    db.sync_team_runs(&[run("run-1", "a"), run("run-2", "b")])
        .unwrap();
    let mut updated = run("run-1", "a 更新");
    updated.payload["goal"] = json!("更新目标");
    db.sync_team_runs(&[updated]).unwrap();
    let loaded = db.load_team_runs().unwrap().expect("some");
    assert_eq!(loaded.len(), 1, "run-2 消失应删除");
    assert_eq!(loaded[0].payload["goal"], "更新目标");
}

fn provider(id: &str, enabled: bool) -> AgentProviderDto {
    AgentProviderDto {
        id: id.to_string(),
        name: format!("后端 {id}"),
        kind: "acp".to_string(),
        command: format!("{id} acp"),
        enabled,
        env: None,
    }
}

#[test]
fn agent_providers_migration_v4_advances_version() {
    let db = Db::open_in_memory().expect("open");
    let conn = db.conn.lock();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MIGRATIONS.len() as i64);
    let count: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'agent_providers'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn agent_providers_load_none_until_first_sync() {
    let db = Db::open_in_memory().expect("open");
    assert!(db.load_agent_providers().unwrap().is_none());
    db.sync_agent_providers(&[]).unwrap();
    assert!(db.load_agent_providers().unwrap().unwrap().is_empty());
}

#[test]
fn agent_providers_roundtrip_preserves_enabled_and_command() {
    let db = Db::open_in_memory().expect("open");
    db.sync_agent_providers(&[provider("opencode", true), provider("codex", false)])
        .unwrap();
    let loaded = db.load_agent_providers().unwrap().expect("some");
    assert_eq!(loaded.len(), 2);
    let opencode = loaded.iter().find(|p| p.id == "opencode").unwrap();
    assert!(opencode.enabled);
    assert_eq!(opencode.command, "opencode acp");
    let codex = loaded.iter().find(|p| p.id == "codex").unwrap();
    assert!(!codex.enabled);
}

#[test]
fn agent_providers_sync_toggles_and_removes_vanished() {
    let db = Db::open_in_memory().expect("open");
    db.sync_agent_providers(&[provider("opencode", true), provider("mock-agent", true)])
        .unwrap();
    // 禁用 opencode + 移除 mock-agent（模拟目录缩减）
    db.sync_agent_providers(&[provider("opencode", false)])
        .unwrap();
    let loaded = db.load_agent_providers().unwrap().expect("some");
    assert_eq!(loaded.len(), 1);
    assert!(!loaded[0].enabled);
}

#[test]
fn enabled_agent_programs_collects_first_tokens_of_enabled_only() {
    let db = Db::open_in_memory().expect("open");
    db.sync_agent_providers(&[
        provider("opencode", true), // "opencode acp" → opencode
        provider("codex", false),   // 禁用 → 不进入可 spawn 面
        AgentProviderDto {
            id: "custom-1".to_string(),
            name: "My Agent".to_string(),
            kind: "acp".to_string(),
            command: "/usr/bin/my-agent --acp".to_string(),
            enabled: true, // 绝对路径 → 取 basename
            env: None,
        },
        AgentProviderDto {
            id: "custom-2".to_string(),
            name: "npx 型".to_string(),
            kind: "acp".to_string(),
            command: "npx -y @acp/whatever".to_string(),
            enabled: true,
            env: None,
        },
    ])
    .unwrap();
    assert_eq!(
        db.enabled_agent_programs(),
        vec!["opencode", "my-agent", "npx"]
    );
}

#[test]
fn enabled_agent_programs_empty_before_takeover() {
    let db = Db::open_in_memory().expect("open");
    assert!(db.enabled_agent_programs().is_empty());
    // 空目录接管后依旧为空（无启用项）
    db.sync_agent_providers(&[]).unwrap();
    assert!(db.enabled_agent_programs().is_empty());
}

#[test]
fn missing_message_id_is_rejected() {
    let db = Db::open_in_memory().expect("open");
    let mut bad = conversation("ses-a", 1);
    bad.messages[0] = json!({ "role": "user", "content": "无 id" });
    let result = db.sync_snapshot(&snapshot_with(vec![bad], None));
    assert!(result.is_err(), "消息缺 id 应整体拒绝（防静默丢消息）");
}

/* ===== automation_due 到期执行队列 ===== */

#[test]
fn due_migration_v5_creates_table_and_advances_version() {
    let db = Db::open_in_memory().expect("open");
    {
        let conn = db.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64, "迁移链推进到最新版本");
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='automation_due'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "automation_due 表存在");
    }
}

#[test]
fn due_push_is_idempotent_per_task_due_at() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
        .unwrap();
    let t = task("at-1", Some("0 9 * * *"), true);
    let now = Db::now_ms();
    assert!(db.automation_due_push(&t, now).unwrap());
    assert!(
        !db.automation_due_push(&t, now).unwrap(),
        "同任务同 due_at 重复入队应被 unique 挡下（宿主重启兜底）"
    );
    assert!(
        db.automation_due_push(&t, now + 60_000).unwrap(),
        "不同 due_at（下一分钟）可入队"
    );
    assert_eq!(db.automation_due_list().unwrap().len(), 2);
}

#[test]
fn due_list_returns_pending_snapshot_in_window_only() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[
        task("at-fresh", Some("0 9 * * *"), true),
        task("at-stale", Some("0 3 * * *"), true),
    ])
    .unwrap();
    let fresh = task("at-fresh", Some("0 9 * * *"), true);
    let stale = task("at-stale", Some("0 3 * * *"), true);
    // 刚到期（now - 1s）与超窗（now - 2h）各一条
    let now = Db::now_ms();
    db.automation_due_push(&fresh, now - 1_000).unwrap();
    db.automation_due_push(&stale, now - 7_200_000).unwrap();
    let items = db.automation_due_list().unwrap();
    assert_eq!(items.len(), 1, "超窗 pending 不进入可执行列表");
    assert_eq!(items[0].task_id, "at-fresh");
    assert_eq!(items[0].intent, fresh.intent);
    assert!(items[0].id > 0);
}

#[test]
fn due_finish_atomically_claims_pending_once() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
        .unwrap();
    let t = task("at-1", Some("0 9 * * *"), true);
    db.automation_due_push(&t, Db::now_ms()).unwrap();
    let item = db.automation_due_list().unwrap().remove(0);
    assert!(db.automation_due_finish(item.id, "success").unwrap());
    assert!(
        !db.automation_due_finish(item.id, "failed").unwrap(),
        "终态行不可二次认领（防双执行者双跑）"
    );
    assert!(
        db.automation_due_list().unwrap().is_empty(),
        "完成行离开可执行列表"
    );
}

#[test]
fn due_sweep_clears_window_expired_pending_and_old_records() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[
        task("at-1", Some("0 9 * * *"), true),
        task("at-2", Some("0 3 * * *"), true),
        task("at-3", Some("0 6 * * *"), true),
    ])
    .unwrap();
    let now = Db::now_ms();
    let t1 = task("at-1", Some("0 9 * * *"), true);
    let t2 = task("at-2", Some("0 3 * * *"), true);
    let t3 = task("at-3", Some("0 6 * * *"), true);
    db.automation_due_push(&t1, now - 7_200_000).unwrap(); // pending 超窗 2h
    db.automation_due_push(&t2, now - 3_600_000).unwrap(); // pending 恰好窗口边界（>= 窗口不删）
    db.automation_due_push(&t3, now - 30_000).unwrap(); // 新鲜
                                                        // 一条完成于 25h 前（超保留期）
    let done_id = db.automation_due_list().unwrap().remove(0);
    let _ = done_id;
    // t3 完成并手动把 updated_at 改旧以测 24h 清理：直接改库
    {
        let conn = db.conn.lock();
        conn.execute(
            "UPDATE automation_due SET status='failed', updated_at = ?1 WHERE task_id='at-3'",
            params![now - 86_400_000 - 1],
        )
        .unwrap();
    }
    db.automation_due_sweep_at(now).unwrap();
    let remaining = db.automation_due_list_at(now).unwrap();
    assert_eq!(remaining.len(), 1, "窗口边界的 pending 仍可执行");
    assert_eq!(remaining[0].task_id, "at-2");
    {
        let conn = db.conn.lock();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM automation_due", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1, "仅 t2（窗口边界 pending）保留");
    }
}

#[tokio::test]
async fn host_exec_finishes_stale_row_failed_without_model_config() {
    // 离线闭环：settings 未初始化 → 宿主无法执行 → 行原子 finish(failed)，
    // 渲染端恢复后不残留死队列（下个 cron 重新到期）。
    let db = Db::open_in_memory().expect("open");
    let task = task("at-host-1", Some("0 9 * * *"), true);
    db.sync_automations(std::slice::from_ref(&task)).unwrap();
    let stale_due_at = chrono::Utc::now().timestamp_millis() - 180_000;
    db.automation_due_push(&task, stale_due_at).unwrap();

    crate::host_exec::claim_and_run(&db, crate::host_exec::DEFAULT_STALE_AFTER_MS).await;

    let remaining = db.automation_due_list().unwrap();
    assert!(remaining.is_empty(), "过期行已被消费");
    {
        let conn = db.conn.lock();
        let status: String = conn
            .query_row(
                "SELECT status FROM automation_due WHERE task_id = 'at-host-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "failed");
        let last_run: i64 = conn
            .query_row(
                "SELECT last_run FROM automation_tasks WHERE id = 'at-host-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_run, 0, "执行失败不更新 last_run");
        let (run_status, mode): (String, String) = conn
            .query_row(
                "SELECT status, mode FROM automation_runs WHERE task_id = 'at-host-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(run_status, "failed", "宿主兜底失败也记一条运行记录");
        assert_eq!(mode, "host", "宿主兜底记录标 host 模式");
    }
}

#[tokio::test]
async fn host_exec_skips_fresh_pending_rows() {
    // 渲染端正常消费窗口内的行宿主不抢（避免双跑）。
    let db = Db::open_in_memory().expect("open");
    let task = task("at-host-2", None, true);
    db.sync_automations(std::slice::from_ref(&task)).unwrap();
    db.automation_due_push(&task, chrono::Utc::now().timestamp_millis())
        .unwrap();

    crate::host_exec::claim_and_run(&db, crate::host_exec::DEFAULT_STALE_AFTER_MS).await;

    let remaining = db.automation_due_list().unwrap();
    assert_eq!(remaining.len(), 1, "fresh 行留给渲染端");
}

#[tokio::test]
async fn host_primary_claims_fresh_rows() {
    // 服务端 `GREYWORK_AUTOMATION_HOST_PRIMARY=1` 的语义：宿主是主执行者，阈值为 0，
    // 到点即认领 —— 与上一个用例是**同一个函数、同一份行**，只有阈值不同，
    // 以此钉死「替补 vs 主执行者」确实由这一个参数区分。
    let db = Db::open_in_memory().expect("open");
    let task = task("at-host-primary", None, true);
    db.sync_automations(std::slice::from_ref(&task)).unwrap();
    db.automation_due_push(&task, chrono::Utc::now().timestamp_millis())
        .unwrap();

    crate::host_exec::claim_and_run(&db, crate::host_exec::HOST_PRIMARY_STALE_AFTER_MS).await;

    assert!(
        db.automation_due_list().unwrap().is_empty(),
        "阈值 0 时刚入队的行就该被认领"
    );
}

#[test]
fn automation_runs_record_and_load_newest_first() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
        .unwrap();
    let mk = |status: &str, ran_at: i64| AutomationRunInputDto {
        task_id: "at-1".into(),
        name: "任务 at-1".into(),
        status: status.into(),
        detail: Some("d".into()),
        session_id: Some("ses-x".into()),
        mode: "llm".into(),
        ran_at,
    };
    db.automation_record_run(&mk("success", 1_000)).unwrap();
    db.automation_record_run(&mk("failed", 2_000)).unwrap();
    let runs = db.automation_runs_load(10).unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].ran_at, 2_000, "按 ran_at 新→旧");
    assert_eq!(runs[0].status, "failed");
    assert_eq!(runs[0].session_id.as_deref(), Some("ses-x"));
}

#[test]
fn automation_runs_trim_keeps_latest_50_per_task() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
        .unwrap();
    for i in 0..60i64 {
        db.automation_record_run(&AutomationRunInputDto {
            task_id: "at-1".into(),
            name: "n".into(),
            status: "success".into(),
            detail: None,
            session_id: None,
            mode: "llm".into(),
            ran_at: i,
        })
        .unwrap();
    }
    let runs = db.automation_runs_load(1000).unwrap();
    assert_eq!(runs.len(), 50, "每任务只保留最近 50 条");
    assert_eq!(runs[0].ran_at, 59);
    assert_eq!(runs.last().unwrap().ran_at, 10, "最旧 10 条被裁剪");
}

#[test]
fn sync_automations_purges_orphan_runs() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[
        task("at-1", Some("0 9 * * *"), true),
        task("at-2", None, true),
    ])
    .unwrap();
    for id in ["at-1", "at-2"] {
        db.automation_record_run(&AutomationRunInputDto {
            task_id: id.into(),
            name: "n".into(),
            status: "success".into(),
            detail: None,
            session_id: None,
            mode: "llm".into(),
            ran_at: 1,
        })
        .unwrap();
    }
    // 移除 at-2：其运行记录随全量替换清理（automation_runs 无外键，靠显式 purge）。
    db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
        .unwrap();
    let runs = db.automation_runs_load(1000).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].task_id, "at-1");
}

#[test]
fn due_rows_cascade_when_task_deleted() {
    let db = Db::open_in_memory().expect("open");
    db.sync_automations(&[task("at-1", Some("0 9 * * *"), true)])
        .unwrap();
    let t = task("at-1", Some("0 9 * * *"), true);
    db.automation_due_push(&t, Db::now_ms()).unwrap();
    // 任务被用户删除（sync 全量替换移除）→ 队列行级联消失
    db.sync_automations(&[]).unwrap();
    assert!(db.automation_due_list().unwrap().is_empty());
}

#[test]
fn acp_provider_binding_roundtrips_task_and_due_queue() {
    let db = Db::open_in_memory().expect("open");
    let mut bound = task("at-acp", Some("0 9 * * 1-5"), true);
    bound.acp_provider_id = Some("opencode".to_string());
    db.sync_automations(&[bound.clone(), task("at-llm", None, true)])
        .unwrap();

    let loaded = db.load_automations().unwrap().expect("some");
    assert_eq!(
        loaded
            .iter()
            .find(|t| t.id == "at-acp")
            .unwrap()
            .acp_provider_id
            .as_deref(),
        Some("opencode")
    );
    assert!(
        loaded
            .iter()
            .find(|t| t.id == "at-llm")
            .unwrap()
            .acp_provider_id
            .is_none(),
        "未绑定后端 = None（本机模型管线）"
    );

    // 队列快照把执行后端一起带走：入队后不再依赖任务行当前的绑定值
    db.automation_due_push(&bound, Db::now_ms()).unwrap();
    let due = db.automation_due_list().unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].acp_provider_id.as_deref(), Some("opencode"));
}

#[test]
fn migration_v6_adds_acp_column_and_rewrites_legacy_weekday() {
    // 先铺到 v5（旧周字段语义），再跑 v6 迁移
    let mut conn = Connection::open_in_memory().expect("open");
    for (index, sql) in MIGRATIONS.iter().take(5).enumerate() {
        conn.execute_batch(sql).unwrap();
        conn.execute_batch(&format!("PRAGMA user_version = {}", index + 1))
            .unwrap();
    }
    conn.execute(
            "INSERT INTO automation_tasks (id, name, schedule, cron, target, intent, enabled, last_run)
             VALUES ('at-legacy', '自动生成周报', '每周五 18:00', '0 18 * * 4', '主仓', '生成周报', 1, 0)",
            [],
        )
        .unwrap();

    migrate(&mut conn).expect("迁移到最新版本");

    let cron: String = conn
        .query_row(
            "SELECT cron FROM automation_tasks WHERE id = 'at-legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(cron, "0 18 * * 5", "旧「周一=0」的周五改写为标准 cron 的 5");
    let acp: Option<String> = conn
        .query_row(
            "SELECT acp_provider_id FROM automation_tasks WHERE id = 'at-legacy'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(acp.is_none(), "旧行升级后未绑定后端");
    // 两张表都补上了列（automation_due 此时为空，能 prepare 即说明列存在）
    assert!(conn
        .prepare("SELECT acp_provider_id FROM automation_due")
        .is_ok());
}

#[test]
fn migration_v7_adds_once_at_column_and_bumps_version() {
    let db = Db::open_in_memory().expect("open");
    let conn = db.conn.lock();
    let has_once: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('automation_tasks') WHERE name = 'once_at'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(has_once, 1, "一次性任务的触发时刻列已就位");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, MIGRATIONS.len() as i64);
}

#[tokio::test]
async fn host_exec_skips_acp_bound_rows() {
    // 绑定 ACP 的任务不换执行者：宿主兜底只跑本机模型，这类行 finish failed
    // （等下个 cron 由应用内执行），而不是被悄悄改用 LLM 跑一遍。
    let db = Db::open_in_memory().expect("open");
    let mut bound = task("at-acp-host", Some("0 9 * * *"), true);
    bound.acp_provider_id = Some("opencode".to_string());
    db.sync_automations(std::slice::from_ref(&bound)).unwrap();
    db.automation_due_push(&bound, chrono::Utc::now().timestamp_millis() - 180_000)
        .unwrap();

    let outcomes =
        crate::host_exec::claim_and_run(&db, crate::host_exec::DEFAULT_STALE_AFTER_MS).await;

    assert_eq!(outcomes.len(), 1);
    assert!(!outcomes[0].ok);
    assert!(
        outcomes[0].detail.contains("ACP"),
        "失败原因要说清是绑定后端导致：{}",
        outcomes[0].detail
    );
    assert!(db.automation_due_list().unwrap().is_empty(), "行已认领");
    let conn = db.conn.lock();
    let status: String = conn
        .query_row(
            "SELECT status FROM automation_due WHERE task_id = 'at-acp-host'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "failed");
}
