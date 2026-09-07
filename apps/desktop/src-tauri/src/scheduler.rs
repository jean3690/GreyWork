//! 调度器（P2）：cron 匹配 + 到点广播。
//!
//! 架构决策：
//! - **判定与入队在宿主，执行在渲染端**：tick 每 30s 读库中 enabled 且带 cron
//!   的任务，当前分钟匹配则**持久化入队**（automation_due 表，库幂等防重），
//!   再 emit `automation://due` 唤醒渲染端；渲染端经单消费循环拉取执行，
//!   成功后 finish 并回写 last_run。busy/重启不丢任务（队列保留 60min 窗口，
//!   渲染端恢复即补跑）——取代旧版「busy 跳过即丢、广播丢失即丢」。
//! - **写者划分**：automation_due 行由宿主 push/sweep 独占写入；渲染端只原子
//!   finish（WHERE status='pending'）自己消费的行。automation_tasks 的 last_run
//!   仍由渲染端独占回写。WAL 多连接并发写安全（busy_timeout 兜底）。
//! - **防重**：unique(task_id, due_at) 库约束幂等（宿主重启后同分钟重推被挡）；
//!   内存记 (task_id, minute_key) 只作快路径（多数 tick 免一次 INSERT OR IGNORE）。
//! - **cron 语义**：5 段（分 时 日 月 周），支持 `*`、`a`、`a-b`、`*/n`、`a-b/n`、
//!   逗号列表。日与月同时受限时按 AND 简化（标准 cron 的 OR 语义不实现——
//!   当前用例只用分/时/周）。
//! - 匹配器为纯组件函数（weekday/hour/minute），不带时区——时区拆分在调用方
//!   （tick 取 Local::now() 组件），单测不依赖运行机器时区。

use crate::host_exec;
use crate::log;
use chrono::{Datelike, Local, Timelike};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use tauri::Emitter;

use crate::db::Db;

const TICK_INTERVAL_SECS: u64 = 30;

/// cron 到期事件信封（渲染端按 id 防抖 + 下发 chat 管线）。
#[derive(serde::Serialize, Clone)]
pub struct AutomationDuePayload {
    pub id: String,
    pub name: String,
    pub target: String,
    pub intent: String,
}

/// 启动周期 tick 循环（setup 阶段调用；失败仅记录，不阻断应用）。
pub fn spawn_ticker(app: tauri::AppHandle, db_path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        // ticker 持独立连接（只读路径：load_automations）；与 manage 的主连接
        // 经 WAL 共存。打开失败（罕见）时重试，每 30s 一次。
        let db = loop {
            match Db::open_at(&db_path) {
                Ok(db) => break db,
                Err(error) => {
                    log::error(
                        "scheduler",
                        format!("ticker 打开数据库失败，将重试: {error}"),
                    );
                    tokio::time::sleep(Duration::from_secs(TICK_INTERVAL_SECS)).await;
                }
            }
        };
        let mut last_broadcast_minute: HashMap<String, i64> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(TICK_INTERVAL_SECS)).await;
            let _ = db.automation_due_sweep(); // 队列清扫：失败仅记录下轮重试
            let now = Local::now();
            let tasks = match db.load_automations() {
                Ok(Some(tasks)) => tasks,
                Ok(None) => continue, // 未接管（渲染端尚未首 sync）：等下一轮
                Err(error) => {
                    log::error("scheduler", format!("读取自动化失败: {error}"));
                    continue;
                }
            };
            let minute_key = now.timestamp() / 60;
            for task in tasks {
                if !task.enabled {
                    continue;
                }
                let Some(expr) = task.cron.as_deref() else {
                    continue; // 手动触发：永不自动到期
                };
                if !cron_matches(
                    expr,
                    now.weekday().num_days_from_monday(),
                    now.hour(),
                    now.minute(),
                ) {
                    continue;
                }
                if last_broadcast_minute.get(&task.id) == Some(&minute_key) {
                    continue; // 本分钟内已入队（快路径：免重复 INSERT OR IGNORE）
                }
                last_broadcast_minute.insert(task.id.clone(), minute_key);
                match db.automation_due_push(&task, now.timestamp_millis()) {
                    Ok(true) => {
                        let _ = app.emit(
                            "automation://due",
                            AutomationDuePayload {
                                id: task.id.clone(),
                                name: task.name.clone(),
                                target: task.target.clone(),
                                intent: task.intent.clone(),
                            },
                        );
                        log::info(
                            "scheduler",
                            format!("到期入队并广播: {} ({})", task.name, task.id),
                        );
                    }
                    Ok(false) => {
                        // 库中已存在同 due_at 的 pending 行（宿主重启后重推）：不重复广播
                    }
                    Err(error) => {
                        log::error("scheduler", format!("到期入队失败: {error}"));
                    }
                }
            }
            // 宿主兜底消费：渲染端超 2min 未消费的到期任务（webview 缺席/长忙），
            // 宿主直接以默认 LLM 单轮回合并落库——不依赖渲染端在线。
            // 逐条结果转系统通知：这是窗口不可见时用户唯一的感知面。
            for outcome in host_exec::claim_and_run(&db).await {
                let title = if outcome.ok {
                    "自动化已完成"
                } else {
                    "自动化执行失败"
                };
                crate::notify::send(
                    &app,
                    title,
                    &format!("{}：{}", outcome.name, outcome.detail),
                );
            }
        }
    });
}

/// 标准 cron 5 段表达式匹配（分 时 日 月 周）。
/// weekday：0-6（周一为 0，周日为 6——本项目内部约定，换算在调用方）；
/// 注意标准 cron 周字段 0/7=周日、1=周一，本函数收到的是已换算组件。
pub fn cron_matches(expr: &str, weekday: u32, hour: u32, minute: u32) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false; // 非法表达式永不匹配（安全降级为手动）
    }
    field_matches(fields[0], minute, 0, 59)
        && field_matches(fields[1], hour, 0, 23)
        && field_matches_day_month(fields[2], fields[3])
        && field_matches(fields[4], weekday, 0, 6)
}

/// 日/月字段：签名无日期组件——字段含 `*` 项才恒真；受限表达式安全不触发
/// （宁可错过，不误触发）。当前用例（分/时/周）不受影响。
fn field_matches_day_month(day: &str, month: &str) -> bool {
    let day_free = day.split(',').any(|p| p.trim() == "*");
    let month_free = month.split(',').any(|p| p.trim() == "*");
    day_free && month_free
}

/// 单字段匹配：支持 `*`、`*/n`、`a`、`a-b`、`a-b/n`、逗号列表。
/// day/month 无组件可用时传 value=1 占位——配合字段 `*` 恒真；
/// 若表达式限制日月而调用方无日期组件，将按 1 日/1 月判定（见 cron_matches 调用）。
fn field_matches(field: &str, value: u32, min: u32, max: u32) -> bool {
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        // 步进解析：`*/n` 或 `a-b/n`
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (
                range,
                step.parse::<u32>().ok().filter(|s| *s > 0).unwrap_or(1),
            ),
            None => (part, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else {
            match range.split_once('-') {
                Some((a, b)) => {
                    let Ok(a) = a.trim().parse::<u32>() else {
                        continue;
                    };
                    let Ok(b) = b.trim().parse::<u32>() else {
                        continue;
                    };
                    (a, b)
                }
                None => {
                    let Ok(v) = range.trim().parse::<u32>() else {
                        continue;
                    };
                    (v, v)
                }
            }
        };
        let Ok(lo) = normalize_range(lo, min, max) else {
            continue;
        };
        let Ok(hi) = normalize_range(hi, min, max) else {
            continue;
        };
        if value >= lo && value <= hi && (value - lo).is_multiple_of(step) {
            return true;
        }
    }
    false
}

/// 越界值拒绝（宽容：仅合法区间参与匹配，非法项整项忽略）。
fn normalize_range(v: u32, min: u32, max: u32) -> Result<u32, ()> {
    if v < min || v > max {
        return Err(());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_minute_wildcard() {
        assert!(cron_matches("* * * * *", 3, 10, 30));
        assert!(cron_matches("* * * * *", 6, 0, 0));
    }

    #[test]
    fn exact_hour_minute_daily() {
        // 每天 09:00
        assert!(cron_matches("0 9 * * *", 2, 9, 0));
        assert!(!cron_matches("0 9 * * *", 2, 8, 59));
        assert!(!cron_matches("0 9 * * *", 2, 9, 1));
        assert!(cron_matches("0 9 * * *", 6, 9, 0), "每日不限周几");
    }

    #[test]
    fn weekly_weekday_and_time() {
        // 每周五 18:00（内部约定周五 weekday=4：周一 0 … 周日 6）
        assert!(cron_matches("0 18 * * 4", 4, 18, 0));
        assert!(!cron_matches("0 18 * * 4", 3, 18, 0), "周四不触发");
        assert!(!cron_matches("0 18 * * 4", 4, 17, 0));
    }

    #[test]
    fn step_minutes() {
        // 每 15 分钟
        assert!(cron_matches("*/15 * * * *", 0, 12, 0));
        assert!(cron_matches("*/15 * * * *", 0, 12, 15));
        assert!(cron_matches("*/15 * * * *", 0, 12, 45));
        assert!(!cron_matches("*/15 * * * *", 0, 12, 20));
    }

    #[test]
    fn range_and_list() {
        assert!(cron_matches("0 9-11 * * *", 0, 10, 0));
        assert!(!cron_matches("0 9-11 * * *", 0, 12, 0));
        assert!(cron_matches("0 9,18 * * *", 0, 18, 0));
        assert!(cron_matches("0 9,18 * * *", 0, 9, 0));
        assert!(!cron_matches("0 9,18 * * *", 0, 12, 0));
        // 跨列表步进：0-30/15
        assert!(cron_matches("0-30/15 * * * *", 0, 0, 30));
        assert!(!cron_matches("0-30/15 * * * *", 0, 0, 45));
    }

    #[test]
    fn invalid_expression_never_matches() {
        assert!(!cron_matches("", 0, 0, 0));
        assert!(!cron_matches("0 9 * *", 0, 9, 0), "四段非法");
        assert!(!cron_matches("x x x x x", 0, 9, 0));
        assert!(!cron_matches("0 25 * * *", 0, 9, 0), "越界时字段");
    }

    #[test]
    fn weekday_convention_monday_is_zero() {
        // 种子任务「每周五 18:00」在 2026-09-04（周五）的组件应为 weekday=4
        // 此处直接验证匹配器对周五组件的判定；组件换算（周一=0）由调用方负责。
        assert!(cron_matches("0 18 * * 4", 4, 18, 0));
        assert!(
            !cron_matches("0 18 * * 0", 4, 18, 0),
            "周日表达式不该命中周五"
        );
    }
}
