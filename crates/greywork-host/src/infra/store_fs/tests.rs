use std::path::PathBuf;

use serde_json::json;

use crate::db::{ConversationDto, Db, SessionsSnapshotDto};

use super::dto::{ConflictDto, RelocateReportDto, RelocateRequestDto, WorkspaceDirDto};
use super::lock::{now_ms, StoreLock, LOCK_DIR, LOCK_OWNER_FILE, LOCK_STALE_MS};
use super::paths::{default_root, prune_session_attachments};
use super::snapshot::{migrate_from_db, read_snapshot, relocate_sessions, write_snapshot};

fn dir(id: &str, folder: Option<&str>) -> WorkspaceDirDto {
    WorkspaceDirDto {
        id: id.into(),
        folder: folder.map(String::from),
    }
}

fn conversation(id: &str, title: &str, workspace_id: Option<&str>, n: usize) -> ConversationDto {
    ConversationDto {
        id: id.into(),
        title: title.into(),
        workspace_id: workspace_id.map(String::from),
        created_at: n as i64,
        updated_at: n as i64,
        messages: (0..n)
            .map(|i| json!({ "id": format!("m{i}"), "content": format!("msg {i}") }))
            .collect(),
    }
}

/// 每个用例独占一个临时 home，避免同一进程内并行用例互相踩锁与文件。
fn temp_home(tag: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!("gw-store-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    home
}

#[test]
fn unready_returns_none_and_sync_takes_over() {
    let tmp = temp_home("ready");
    let root = default_root(&tmp).unwrap();
    assert_eq!(root, tmp.join(".greyWork"));

    // 未就绪 → None（前端种子回写语义）
    assert!(read_snapshot(&root, &[]).unwrap().is_none());

    let snapshot = SessionsSnapshotDto {
        sessions: vec![conversation("ses-a", "A", None, 2)],
        active_session_id: Some("ses-a".into()),
    };
    let report = write_snapshot(&root, &snapshot, &[], &[]).unwrap();
    assert_eq!(report.written, 1);
    let loaded = read_snapshot(&root, &[])
        .unwrap()
        .expect("接管后应返回真源");
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].messages.len(), 2);
    assert_eq!(loaded.active_session_id.as_deref(), Some("ses-a"));

    // 空快照 = 用户清空（不复活）；文件本身要靠显式删除清单才消失
    write_snapshot(
        &root,
        &SessionsSnapshotDto::default(),
        &[],
        &["ses-a".into()],
    )
    .unwrap();
    let loaded = read_snapshot(&root, &[]).unwrap().expect("接管后空真源");
    assert!(loaded.sessions.is_empty());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn workspace_bound_sessions_land_in_workspace_dir() {
    let tmp = temp_home("ws");
    let root = default_root(&tmp).unwrap();
    let ws_folder = tmp.join("my-project");
    std::fs::create_dir_all(&ws_folder).unwrap();

    let workspaces = vec![dir("w-1", Some(&ws_folder.to_string_lossy()))];
    let snapshot = SessionsSnapshotDto {
        sessions: vec![
            conversation("ses-ws", "工作区会话", Some("w-1"), 1),
            conversation("ses-free", "自由会话", None, 1),
        ],
        active_session_id: None,
    };
    write_snapshot(&root, &snapshot, &workspaces, &[]).unwrap();

    // 工作区文件落在 <folder>/.greyWork/sessions/
    assert!(ws_folder.join(".greyWork/sessions/ses-ws.json").exists());
    // 默认目录是 ~/.greyWork/sessions/
    assert!(root.join("sessions/ses-free.json").exists());

    let loaded = read_snapshot(&root, &workspaces).unwrap().unwrap();
    assert_eq!(loaded.sessions.len(), 2);

    // 工作区失效（目录被删）→ 不阻塞加载，其余照常
    std::fs::remove_dir_all(&ws_folder).unwrap();
    let loaded = read_snapshot(&root, &workspaces).unwrap().unwrap();
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].id, "ses-free");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn unchanged_sessions_are_skipped_without_touching_files() {
    let tmp = temp_home("incr");
    let root = default_root(&tmp).unwrap();
    let snapshot = SessionsSnapshotDto {
        sessions: vec![
            conversation("ses-a", "A", None, 1),
            conversation("ses-b", "B", None, 2),
        ],
        active_session_id: None,
    };
    let first = write_snapshot(&root, &snapshot, &[], &[]).unwrap();
    assert_eq!((first.written, first.skipped), (2, 0));

    let path = root.join("sessions/ses-a.json");
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    let second = write_snapshot(&root, &snapshot, &[], &[]).unwrap();
    assert_eq!(
        (second.written, second.skipped),
        (0, 2),
        "内容未变应全部跳过"
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        before,
        "跳过的文件不该被重写"
    );

    // 内容有变 → 重新写入
    let mut bumped = snapshot;
    bumped.sessions[0].title = "A2".into();
    bumped.sessions[0].updated_at = 99;
    let third = write_snapshot(&root, &bumped, &[], &[]).unwrap();
    assert_eq!((third.written, third.skipped), (1, 1));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn newer_disk_version_is_reported_as_conflict_and_kept() {
    let tmp = temp_home("conflict");
    let root = default_root(&tmp).unwrap();
    let mut fresh = conversation("ses-a", "磁盘版", None, 1);
    fresh.updated_at = 5_000;
    write_snapshot(
        &root,
        &SessionsSnapshotDto {
            sessions: vec![fresh],
            active_session_id: None,
        },
        &[],
        &[],
    )
    .unwrap();

    // 内存里是更旧的版本（另一实例已写过更新内容）
    let mut stale = conversation("ses-a", "内存旧版", None, 1);
    stale.updated_at = 1_000;
    let report = write_snapshot(
        &root,
        &SessionsSnapshotDto {
            sessions: vec![stale],
            active_session_id: None,
        },
        &[],
        &[],
    )
    .unwrap();
    assert_eq!(report.written, 0);
    assert_eq!(
        report.conflicts,
        vec![ConflictDto {
            id: "ses-a".into(),
            disk_updated_at: 5_000
        }]
    );
    let loaded = read_snapshot(&root, &[]).unwrap().unwrap();
    assert_eq!(loaded.sessions[0].title, "磁盘版", "冲突时磁盘版本不被覆盖");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn only_explicit_deletions_remove_files() {
    let tmp = temp_home("delete");
    let root = default_root(&tmp).unwrap();
    let snapshot = SessionsSnapshotDto {
        sessions: vec![
            conversation("ses-old", "旧", None, 1),
            conversation("ses-keep", "留", None, 1),
        ],
        active_session_id: None,
    };
    write_snapshot(&root, &snapshot, &[], &[]).unwrap();

    // 另一实例刚建的会话文件（本实例快照里没有）
    let foreign = root.join("sessions/ses-foreign.json");
    std::fs::write(
        &foreign,
        serde_json::to_string(&conversation("ses-foreign", "别的实例", None, 1)).unwrap(),
    )
    .unwrap();

    let pruned = SessionsSnapshotDto {
        sessions: vec![conversation("ses-keep", "留", None, 1)],
        active_session_id: None,
    };
    let report = write_snapshot(&root, &pruned, &[], &["ses-old".into()]).unwrap();
    assert_eq!(report.deleted, 1);
    assert!(!root.join("sessions/ses-old.json").exists());
    assert!(root.join("sessions/ses-keep.json").exists());
    assert!(foreign.exists(), "陌生会话文件不该被清扫掉");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn relocate_moves_sessions_into_workspace_dir() {
    let tmp = temp_home("relocate");
    let root = default_root(&tmp).unwrap();
    let folder = tmp.join("proj");
    std::fs::create_dir_all(&folder).unwrap();
    let snapshot = SessionsSnapshotDto {
        sessions: vec![
            conversation("ses-a", "A", None, 1),
            conversation("ses-b", "B", None, 1),
        ],
        active_session_id: None,
    };
    write_snapshot(&root, &snapshot, &[], &[]).unwrap();

    let request = RelocateRequestDto {
        session_ids: vec!["ses-a".into(), "ses-b".into(), "ses-missing".into()],
        from_folder: None,
        to_folder: Some(folder.to_string_lossy().into_owned()),
    };
    let report = relocate_sessions(&root, &request).unwrap();
    assert_eq!(report.moved, 2);
    assert_eq!(report.missing, vec!["ses-missing".to_string()]);
    assert!(report.conflicts.is_empty());
    assert!(!root.join("sessions/ses-a.json").exists(), "源文件应被搬走");
    let moved = folder.join(".greyWork/sessions/ses-a.json");
    assert!(moved.exists());
    let payload: ConversationDto =
        serde_json::from_str(&std::fs::read_to_string(&moved).unwrap()).unwrap();
    assert_eq!(payload.title, "A");

    // 同目录搬迁 = no-op
    let same = relocate_sessions(
        &root,
        &RelocateRequestDto {
            session_ids: vec!["ses-a".into()],
            from_folder: None,
            to_folder: None,
        },
    )
    .unwrap();
    assert_eq!(same, RelocateReportDto::default());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn relocate_keeps_both_sides_on_conflict() {
    let tmp = temp_home("relocate-conflict");
    let root = default_root(&tmp).unwrap();
    let folder = tmp.join("proj");
    let target_dir = folder.join(".greyWork/sessions");
    std::fs::create_dir_all(&target_dir).unwrap();

    let mut source = conversation("ses-a", "源旧版", None, 1);
    source.updated_at = 1_000;
    write_snapshot(
        &root,
        &SessionsSnapshotDto {
            sessions: vec![source],
            active_session_id: None,
        },
        &[],
        &[],
    )
    .unwrap();
    let mut target = conversation("ses-a", "目标新版", None, 1);
    target.updated_at = 9_000;
    std::fs::write(
        target_dir.join("ses-a.json"),
        serde_json::to_string(&target).unwrap(),
    )
    .unwrap();

    let report = relocate_sessions(
        &root,
        &RelocateRequestDto {
            session_ids: vec!["ses-a".into()],
            from_folder: None,
            to_folder: Some(folder.to_string_lossy().into_owned()),
        },
    )
    .unwrap();
    assert_eq!(report.moved, 0);
    assert_eq!(report.conflicts, vec!["ses-a".to_string()]);
    assert!(
        root.join("sessions/ses-a.json").exists(),
        "冲突时源文件保留"
    );
    let kept: ConversationDto =
        serde_json::from_str(&std::fs::read_to_string(target_dir.join("ses-a.json")).unwrap())
            .unwrap();
    assert_eq!(kept.title, "目标新版");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn lock_is_exclusive_and_reclaims_stale_holder() {
    let tmp = temp_home("lock");
    let root = default_root(&tmp).unwrap();

    // 持有期间：目录锁存在；释放后消失
    {
        let _guard = StoreLock::acquire(&root).unwrap();
        assert!(root.join(LOCK_DIR).exists());
        assert!(
            std::fs::create_dir(root.join(LOCK_DIR)).is_err(),
            "锁目录应互斥"
        );
    }
    assert!(!root.join(LOCK_DIR).exists(), "Drop 应释放锁");

    // 陈旧锁（owner 时间戳远超阈值）→ 可强行接管
    let lock_dir = root.join(LOCK_DIR);
    std::fs::create_dir(&lock_dir).unwrap();
    let stale_at = now_ms().saturating_sub(LOCK_STALE_MS * 3) as u64;
    std::fs::write(
        lock_dir.join(LOCK_OWNER_FILE),
        serde_json::json!({ "pid": 1, "at": stale_at }).to_string(),
    )
    .unwrap();
    let guard = StoreLock::acquire(&root).expect("陈旧锁应被接管");
    drop(guard);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn migrate_exports_legacy_db_once() {
    let tmp = temp_home("mig");
    let root = default_root(&tmp).unwrap();

    // 旧库：真实 SQLite 文件（Db::open_at），已接管且有两会话
    let db_path = tmp.join("greywork.db");
    let db = Db::open_at(&db_path).unwrap();
    let legacy = SessionsSnapshotDto {
        sessions: vec![conversation("legacy-1", "旧会话", None, 3)],
        active_session_id: Some("legacy-1".into()),
    };
    db.sync_snapshot(&legacy).unwrap();

    // 文件面未就绪 → 迁移并返回旧快照；再次 load 走文件面（幂等）
    let loaded = migrate_from_db(&root, &db, &[])
        .unwrap()
        .expect("迁移应返回数据");
    assert_eq!(loaded.sessions[0].id, "legacy-1");
    assert!(root.join("sessions/legacy-1.json").exists());
    assert!(root.join(".ready").exists());
    assert!(migrate_from_db(&root, &db, &[]).unwrap().is_none());

    // 清空旧库后文件面仍是真源（不回退）
    db.sync_snapshot(&SessionsSnapshotDto::default()).unwrap();
    let loaded = read_snapshot(&root, &[]).unwrap().unwrap();
    assert_eq!(loaded.sessions.len(), 1);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn prune_session_attachments_removes_only_that_session() {
    let tmp = temp_home("att");
    let root = default_root(&tmp).unwrap();
    let target = root.join("attachments/ses-a");
    let other = root.join("attachments/ses-b");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(target.join("att-1.png"), b"x").unwrap();

    prune_session_attachments(&root, "ses-a").unwrap();
    assert!(!target.exists());
    assert!(other.exists(), "别的会话的附件不能被带上");
    // 幂等：目录已不在（或从没发过附件）不算失败
    prune_session_attachments(&root, "ses-a").unwrap();
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn prune_session_attachments_rejects_traversal_ids() {
    let tmp = temp_home("att-bad");
    let root = default_root(&tmp).unwrap();
    let victim = tmp.join("victim");
    std::fs::create_dir_all(&victim).unwrap();

    for id in [
        "",
        "..",
        "../victim",
        "a/b",
        "a\\b",
        ".hidden",
        // Windows 盘符相对路径：`join` 会整段替换基准目录
        "C:evil",
        "c:",
        // Win32 保留设备名与结尾点（会被静默剥掉而与 `CON` 撞名）
        "CON",
        "con.txt",
        "foo.",
    ] {
        assert!(
            prune_session_attachments(&root, id).is_err(),
            "id {id:?} 应被拒绝"
        );
    }
    assert!(victim.exists(), "越界 id 不能删到附件根之外");
    let _ = std::fs::remove_dir_all(&tmp);
}
