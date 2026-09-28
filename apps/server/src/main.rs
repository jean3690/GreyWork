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
        Some("healthcheck") => std::process::exit(cmd_healthcheck()),
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

/// 探活：连本机环回的监听端口打 `/api/health`，200 则退出 0，否则 1。
///
/// 刻意不引 HTTP 客户端库、也不装 curl —— 运行时镜像保持无多余工具。用裸 TCP
/// 发一个 HTTP/1.0 请求，够判活。端口取自 `bind`（`0.0.0.0:P` 也连 `127.0.0.1:P`）。
fn cmd_healthcheck() -> i32 {
    use std::io::{Read, Write};
    let config = match ServerConfig::load() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("healthcheck: 读配置失败: {error}");
            return 1;
        }
    };
    let Some(port) = config
        .bind
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
    else {
        eprintln!("healthcheck: 无法从 bind={} 解析端口", config.bind);
        return 1;
    };
    let addr = format!("127.0.0.1:{port}");
    let timeout = std::time::Duration::from_secs(3);
    let mut stream = match std::net::TcpStream::connect(&addr) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("healthcheck: 连接 {addr} 失败: {error}");
            return 1;
        }
    };
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if let Err(error) = stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
    {
        eprintln!("healthcheck: 发送失败: {error}");
        return 1;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let healthy = response
        .lines()
        .next()
        .is_some_and(|status| status.contains(" 200"));
    if healthy {
        0
    } else {
        eprintln!("healthcheck: /api/health 非 200");
        1
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
           greywork-server set-password    从 stdin 读密码并写入 <data_dir>/auth.json（0600）\n  \
           greywork-server healthcheck     探活本机 /api/health（容器 HEALTHCHECK 用），0=健康\n\n\
         常用环境变量:\n  \
           GREYWORK_BIND / GREYWORK_DATA_DIR / GREYWORK_HOME_DIR\n  \
           GREYWORK_PASSWORD_HASH / GREYWORK_PASSWORD\n  \
           GREYWORK_AGENT_PROGRAMS / GREYWORK_WORKSPACE_ROOTS\n  \
           GREYWORK_SANDBOX / GREYWORK_TIER / GREYWORK_SECURE_COOKIE / GREYWORK_ALLOWED_ORIGINS\n  \
           GREYWORK_STATIC_DIR                 前端构建产物目录（配了即同源托管 SPA；缺 index.html 会启动失败）"
    );
}
