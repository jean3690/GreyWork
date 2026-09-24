//! 服务端可执行入口。
//!
//! 无子命令 → 起服务；`hash-password` / `set-password` 辅助配置登录密码。

use greywork_server::config::{self, ServerConfig};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("hash-password") => std::process::exit(cmd_hash_password()),
        Some("set-password") => std::process::exit(cmd_set_password()),
        Some("help" | "--help" | "-h") => print_help(),
        _ => {
            if let Err(error) = greywork_server::run().await {
                eprintln!("greywork-server 启动失败: {error}");
                std::process::exit(1);
            }
        }
    }
}

/// 从 stdin 读两遍密码，哈希成 argon2 PHC 串打印到 stdout。
fn cmd_hash_password() -> i32 {
    let Some(password) = read_password_twice() else {
        return 1;
    };
    match config::hash_password(&password) {
        Ok(hash) => {
            println!("{hash}");
            0
        }
        Err(error) => {
            eprintln!("哈希失败: {error}");
            1
        }
    }
}

/// 从 stdin 读两遍密码，写入 `<data_dir>/auth.json`（0600）。
fn cmd_set_password() -> i32 {
    let config = match ServerConfig::load() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("读取配置失败: {error}");
            return 1;
        }
    };
    if let Err(error) = std::fs::create_dir_all(&config.data_dir) {
        eprintln!("创建数据目录失败: {error}");
        return 1;
    }
    let Some(password) = read_password_twice() else {
        return 1;
    };
    let hash = match config::hash_password(&password) {
        Ok(hash) => hash,
        Err(error) => {
            eprintln!("哈希失败: {error}");
            return 1;
        }
    };
    let path = config.data_dir.join("auth.json");
    match config::write_auth_hash(&path, &hash) {
        Ok(()) => {
            println!("已写入 {}", path.display());
            0
        }
        Err(error) => {
            eprintln!("{error}");
            1
        }
    }
}

fn read_password_twice() -> Option<String> {
    let first = read_line("请输入新密码: ")?;
    if first.is_empty() {
        eprintln!("密码不能为空");
        return None;
    }
    let second = read_line("请再次输入确认: ")?;
    if first != second {
        eprintln!("两次输入不一致");
        return None;
    }
    Some(first)
}

fn read_line(prompt: &str) -> Option<String> {
    use std::io::{BufRead, Write};
    print!("{prompt}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    match std::io::stdin().lock().read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_string()),
    }
}

fn print_help() {
    println!(
        "greywork-server —— GreyWork 单用户自托管服务端\n\n\
         用法:\n  \
           greywork-server                 启动服务（读 GREYWORK_* 与 <data_dir>/server.json）\n  \
           greywork-server hash-password   从 stdin 读密码并打印 argon2 PHC 串\n  \
           greywork-server set-password    从 stdin 读密码并写入 <data_dir>/auth.json（0600）\n\n\
         常用环境变量:\n  \
           GREYWORK_BIND / GREYWORK_DATA_DIR / GREYWORK_HOME_DIR\n  \
           GREYWORK_PASSWORD_HASH / GREYWORK_PASSWORD\n  \
           GREYWORK_AGENT_PROGRAMS / GREYWORK_WORKSPACE_ROOTS\n  \
           GREYWORK_SANDBOX / GREYWORK_TIER / GREYWORK_SECURE_COOKIE / GREYWORK_ALLOWED_ORIGINS"
    );
}
