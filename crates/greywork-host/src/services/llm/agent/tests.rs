//! agent 工具面的测试。
//!
//! 重点钉三类行为，因为它们都是「错了会静默劣化」而不是「崩给你看」：
//! - **授权**：越界路径必须拿到错误（不能读，也不能假装读到了空文件）；
//! - **截断**：必须对模型可见地标注省略了多少（静默截断会让模型基于残缺内容下结论）；
//! - **坏输入**：未知工具名 / 非法 arguments 都要变成给模型看的错误，不是 panic。

use std::fs;
use std::path::Path;

use serde_json::json;

use super::tools::{execute, tool_schemas, MAX_TOOL_OUTPUT_CHARS};
use crate::workspace_fs::WorkspaceFsAccess;

/// 建一个带临时工作区的授权面；返回 (access, 根, 临时目录守卫)。
fn workspace() -> (WorkspaceFsAccess, PathBuf, TempDir) {
    let temp = TempDir::new("llm-agent-tools");
    let root = temp.path().join("root");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("hello.txt"), "hello world").unwrap();
    fs::write(
        root.join("big.txt"),
        "x".repeat(MAX_TOOL_OUTPUT_CHARS + 500),
    )
    .unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/app.rs"), "fn main() {}").unwrap();
    // 授权面**外**的文件：工具必须读不到。
    fs::write(temp.path().join("secret.txt"), "TOP SECRET").unwrap();
    let access = WorkspaceFsAccess::new(&root, temp.path().join("access.json")).unwrap();
    (access, root, temp)
}

use std::path::PathBuf;

/// 极简临时目录守卫（测试里不想为 tempfile 加依赖；仓库的 dev-dependencies 里没有它）。
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let unique = format!(
            "greywork-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn read_file_returns_authorized_content() {
    let (access, root, _temp) = workspace();
    let target = root.join("hello.txt");
    let output = execute(
        &access,
        "read_file",
        &json!({"path": target.to_string_lossy()}),
    );
    assert_eq!(output.error, None);
    assert!(output.content.contains("hello world"));
    assert!(output.summary.contains("hello.txt"), "{}", output.summary);
    assert!(output.summary.contains("11 字符"), "{}", output.summary);
    assert_eq!(
        output.path.as_deref(),
        Some(target.to_string_lossy().as_ref())
    );
}

#[test]
fn read_file_works_with_a_path_relative_to_the_default_root() {
    let (access, _root, _temp) = workspace();
    // 模型最可能给的就是相对路径（「src/app.rs」），必须能解析。
    let output = execute(&access, "read_file", &json!({"path": "src/app.rs"}));
    assert_eq!(output.error, None);
    assert!(output.content.contains("fn main"));
}

/// 授权面外的路径必须失败，且失败文案**不区分**「未授权」与「不存在」——
/// 告诉模型「这个路径存在但没授权」等于送它一张授权面的地图。
#[test]
fn read_file_refuses_paths_outside_the_authorized_root() {
    let (access, _root, temp) = workspace();
    let secret = temp.path().join("secret.txt");
    let output = execute(
        &access,
        "read_file",
        &json!({"path": secret.to_string_lossy()}),
    );
    assert!(output.error.is_some(), "越界路径必须失败");
    assert!(
        !output.content.contains("TOP SECRET"),
        "越界文件内容绝不能出现在回给模型的文本里"
    );
    // 与不存在的路径给出同一形态的错误（措辞可不同，但都不能泄露「存在与否」）
    let missing = execute(&access, "read_file", &json!({"path": "/nope/not/here.txt"}));
    assert!(missing.error.is_some());
}

/// 相对路径锚定不能削弱授权：`../` 逃逸照样被拒。
///
/// 锚定层（`anchor_to_root`）只拼路径、不判授权 —— 授权判定仍在 `resolve_existing`
/// 里、且发生在 `canonicalize` 之后。这条测试钉住这个分工：哪天有人为了"省一次检查"
/// 在锚定层加个 starts_with 快路径，这里就会红。
#[test]
fn relative_paths_cannot_escape_the_authorized_root() {
    let (access, _root, _temp) = workspace();
    // secret.txt 就在工作区根的**上一级**（见 workspace()），`../` 能解析到它。
    let output = execute(&access, "read_file", &json!({"path": "../secret.txt"}));
    assert!(output.error.is_some(), "`..` 逃逸必须被拒");
    assert!(!output.content.contains("TOP SECRET"));
}

#[test]
fn read_file_truncates_and_says_how_much_was_dropped() {
    let (access, root, _temp) = workspace();
    let output = execute(
        &access,
        "read_file",
        &json!({"path": root.join("big.txt").to_string_lossy()}),
    );
    assert_eq!(output.error, None);
    assert!(
        output.content.contains("已截断"),
        "截断必须对模型可见：{}",
        &output.content[output.content.len().saturating_sub(120)..]
    );
    assert!(output
        .content
        .contains(&format!("共 {} 字符", MAX_TOOL_OUTPUT_CHARS + 500)));
}

#[test]
fn read_file_rejects_missing_and_wrong_typed_arguments() {
    let (access, _root, _temp) = workspace();
    for input in [
        json!({}),
        json!({"path": ""}),
        json!({"path": 42}),
        json!({"path": null}),
    ] {
        let output = execute(&access, "read_file", &input);
        assert!(output.error.is_some(), "{input} 应报错");
    }
}

#[test]
fn list_dir_defaults_to_the_workspace_root_and_marks_subdirectories() {
    let (access, _root, _temp) = workspace();
    let output = execute(&access, "list_dir", &json!({}));
    assert_eq!(output.error, None);
    assert!(output.content.contains("hello.txt"));
    // 目录带尾斜杠：模型据此区分「能进去的目录」和「同名文件」。
    assert!(
        output.content.contains("src/"),
        "目录应带尾斜杠: {}",
        output.content
    );
}

#[test]
fn list_dir_refuses_unauthorized_directories() {
    let (access, _root, temp) = workspace();
    let output = execute(
        &access,
        "list_dir",
        &json!({"path": temp.path().to_string_lossy()}),
    );
    assert!(output.error.is_some());
}

#[test]
fn git_log_reports_empty_history_instead_of_failing_on_a_non_repo() {
    let (access, _root, _temp) = workspace();
    // git 对非仓库与空仓库都回空列表：这不是错误，但模型必须知道自己拿到的是空的。
    let output = execute(&access, "git_log", &json!({}));
    assert_eq!(output.error, None);
    assert!(
        output.content.contains("没有提交历史"),
        "{}",
        output.content
    );
    // limit 非法值要报错，而不是被静默当成默认（模型会以为自己要了 10 条）。
    for input in [
        json!({"limit": 0}),
        json!({"limit": -3}),
        json!({"limit": "十"}),
    ] {
        assert!(
            execute(&access, "git_log", &input).error.is_some(),
            "{input}"
        );
    }
}

/// 未知工具名 → 给模型一条「可用工具是…」的错误，好过崩掉整个回合。
#[test]
fn unknown_tool_name_returns_a_recoverable_error_naming_the_real_tools() {
    let (access, _root, _temp) = workspace();
    let output = execute(&access, "read_files", &json!({"paths": []}));
    assert!(output.error.is_some());
    for expected in ["read_file", "list_dir", "git_log"] {
        assert!(
            output.content.contains(expected),
            "错误文案应列出 {expected}"
        );
    }
}

#[test]
fn empty_tool_name_is_reported_not_panicked() {
    let (access, _root, _temp) = workspace();
    let output = execute(&access, "", &json!({}));
    assert!(output.error.is_some());
    assert!(output.content.contains("工具名"));
}

/// schema 形状：`name` / `description` / `parameters` 齐全，且没有用 strict
/// （strict 要求所有参数都在 required 里，与 `path` 可省略的语义冲突）。
#[test]
fn tool_schemas_are_well_formed_and_never_strict() {
    let schemas = tool_schemas();
    assert_eq!(schemas.len(), 3);
    let names: Vec<&str> = schemas
        .iter()
        .filter_map(|schema| schema.pointer("/function/name").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(names, vec!["read_file", "list_dir", "git_log"]);
    for schema in &schemas {
        assert_eq!(schema["type"], "function");
        let function = &schema["function"];
        assert!(
            function["description"]
                .as_str()
                .is_some_and(|text| !text.is_empty()),
            "每个工具都要有描述，否则模型不知道何时调用"
        );
        assert_eq!(function["parameters"]["type"], "object");
        assert!(
            function.get("strict").is_none(),
            "strict 与可选参数冲突，不能加"
        );
    }
    // path 可省略：list_dir / git_log 的 required 要么缺省要么为空数组。
    let list_dir = schemas
        .iter()
        .find(|s| s["function"]["name"] == "list_dir")
        .unwrap();
    let required = list_dir["function"]["parameters"].get("required");
    assert!(
        required.is_none() || required == Some(&json!([])),
        "list_dir 的 path 可省略"
    );
}
