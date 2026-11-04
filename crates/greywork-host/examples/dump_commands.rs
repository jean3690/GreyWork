//! 导出命令元数据（name / auth / desktopOnly / binary）为 JSON。
//!
//! 用途：Node 宿主（apps/host-node）的迁移清单。命令真源仍在这份 Rust 表；
//! Node 侧只消费这份快照，并用 `scripts/gen-command-manifest.mjs` 在漂移时重新生成。
//!
//! 用法：cargo run -q -p greywork-host --example dump_commands > apps/host-node/src/command-manifest.json

use greywork_host::commands::{Auth, COMMANDS};

fn main() {
    let items: Vec<serde_json::Value> = COMMANDS
        .iter()
        .map(|meta| {
            serde_json::json!({
                "name": meta.name,
                "auth": match meta.auth {
                    Auth::Required => "required",
                    Auth::None => "none",
                },
                "desktopOnly": meta.desktop_only,
                "binary": meta.binary,
            })
        })
        .collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&items).expect("serialize commands")
    );
}
