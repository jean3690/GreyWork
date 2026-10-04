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
//! - **cron 语义**：交给 `cron` 模块（标准 5 段 + 日/周 OR + 宏；非法表达式永不触发）。
//!   本模块只负责「取当前本地时刻组件 → 判定 → 持久化入队 → 广播」。
//! - 时刻组件带时区语义（tick 取 Local::now()），匹配器本身是纯函数，单测不依赖
//!   运行机器时区。

use crate::cron;
use crate::host::{self, HostContext};
use crate::host_exec;
use crate::log;
use chrono::{Datelike, Local, Timelike};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

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

/// 周期 tick 循环（**无限循环，由各宿主自行 spawn**）。
///
/// `stale_after_ms` 透传给 [`host_exec::claim_and_run`]，决定宿主是「替补」还是
/// 「主执行者」：桌面壳传 [`host_exec::DEFAULT_STALE_AFTER_MS`]（渲染端在场，宿主兜底）；
/// 无人值守服务端传 [`host_exec::HOST_PRIMARY_STALE_AFTER_MS`]（到点即执行，不必等
/// 一台开着的电脑）。两种角色对到期的判定（cron / once）完全一致，差别只在多晚认领。
///
/// 不在本函数里 spawn：桌面壳在 Tauri `setup` 阶段调用，那时还没有 tokio runtime 上下文，
/// 裸 `tokio::spawn` 会 panic；服务端则希望用自己的 runtime。把「怎么起」留给宿主，
/// 这里只管「跑什么」。
pub async fn run_ticker(host: Arc<dyn HostContext>, db_path: PathBuf, stale_after_ms: i64) {
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
        let now_ms = now.timestamp_millis();
        for task in tasks {
            if !task.enabled {
                continue;
            }
            // 一次性任务：按时间戳判定，跑过（last_run != 0）即永不再触发。
            // 它不写 cron（cron 没有年份字段），所以两条排期路径在这里分岔。
            let due_at = match task.once_at {
                Some(once_at) => {
                    if task.last_run != 0 || now_ms < once_at {
                        continue;
                    }
                    once_at
                }
                None => {
                    let Some(expr) = task.cron.as_deref() else {
                        continue; // 手动触发：永不自动到期
                    };
                    if !cron::matches(
                        expr,
                        now.month(),
                        now.day(),
                        now.weekday().num_days_from_sunday(),
                        now.hour(),
                        now.minute(),
                    ) {
                        continue;
                    }
                    if last_broadcast_minute.get(&task.id) == Some(&minute_key) {
                        continue; // 本分钟内已入队（快路径：免重复 INSERT OR IGNORE）
                    }
                    last_broadcast_minute.insert(task.id.clone(), minute_key);
                    now_ms
                }
            };
            match db.automation_due_push(&task, due_at) {
                Ok(true) => {
                    // 一次性任务在入队时就把 last_run 占住：应用不在场时由 host_exec
                    // 兜底执行，若不占住，重启后渲染端还会把 last_run 同步回 0，下个
                    // tick 就再推一次——「只跑一次」的语义随之破掉。
                    if task.once_at.is_some() {
                        if let Err(error) = db.automation_mark_last_run(&task.id, now_ms) {
                            log::error(
                                "scheduler",
                                format!("一次性任务标记 last_run 失败: {error}"),
                            );
                        }
                    }
                    host::emit_json(
                        host.as_ref(),
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
        // 宿主消费到期任务。桌面端这是**兜底**（渲染端超 2min 未消费才算它缺席）；
        // 服务端配了 GREYWORK_AUTOMATION_HOST_PRIMARY 时阈值为 0，宿主就是主执行者。
        // 两种情形都走同一套行级原子认领，双执行防护不变。
        // 逐条结果转系统通知：这是窗口不可见时用户唯一的感知面。
        for outcome in host_exec::claim_and_run(&db, stale_after_ms).await {
            let title = if outcome.ok {
                "自动化已完成"
            } else {
                "自动化执行失败"
            };
            host.notify(title, &format!("{}：{}", outcome.name, outcome.detail));
        }
    }
}
