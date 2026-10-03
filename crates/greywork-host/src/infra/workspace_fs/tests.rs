use super::read::*;
use super::transfer::*;
use super::write::*;
use super::*;

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时间早于 UNIX 纪元")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("greywork-fs-{tag}-{nanos}"));
    std::fs::create_dir_all(&dir).expect("创建临时目录");
    dir
}

fn access(root: &Path) -> WorkspaceFsAccess {
    WorkspaceFsAccess::new(root, root.parent().unwrap().join("gw-access-test.json"))
        .expect("创建授权状态")
}

#[test]
fn authorization_rejects_sibling_and_parent_traversal() {
    let root = temp_dir("boundary");
    let sibling = root.parent().unwrap().join("greywork-outside.txt");
    std::fs::write(&sibling, b"secret").expect("写外部文件");
    let access = access(&root);
    assert!(access.resolve_existing(&sibling.to_string_lossy()).is_err());
    assert!(access
        .resolve_write(&root.join("../escape.txt").to_string_lossy())
        .is_err());
    let _ = std::fs::remove_file(sibling);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn selected_file_is_exact_not_parent_wide_authorization() {
    let root = temp_dir("exact-root");
    let outside = temp_dir("exact-outside");
    let selected = outside.join("chosen.txt");
    let other = outside.join("other.txt");
    std::fs::write(&selected, b"chosen").expect("写已选文件");
    std::fs::write(&other, b"other").expect("写相邻文件");
    let access = access(&root);
    access
        .authorize_selected_path(&selected)
        .expect("授权选中文件");
    assert!(access.resolve_existing(&selected.to_string_lossy()).is_ok());
    assert!(access.resolve_existing(&other.to_string_lossy()).is_err());
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

#[cfg(unix)]
#[test]
fn symlink_cannot_escape_authorized_root() {
    use std::os::unix::fs::symlink;
    let root = temp_dir("symlink-root");
    let outside = temp_dir("symlink-outside");
    std::fs::write(outside.join("secret.txt"), b"secret").expect("写外部文件");
    symlink(&outside, root.join("link")).expect("创建符号链接");
    let access = access(&root);
    assert!(access
        .resolve_existing(&root.join("link/secret.txt").to_string_lossy())
        .is_err());
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 快速路径的基本正确性：文件名 / 类型 / 大小 / 路径都要与逐项 canonicalize 时代一致。
#[test]
fn list_dir_reports_name_kind_size_and_canonical_path() {
    let root = temp_dir("listdir-shape");
    let access = access(&root);
    std::fs::write(root.join("note.txt"), b"hello").expect("写文件");
    std::fs::create_dir_all(root.join("sub")).expect("建子目录");
    std::fs::write(root.join("sub/deep.txt"), b"x").expect("写子目录文件");

    let canonical_root = std::fs::canonicalize(&root).expect("canonicalize 根目录");
    // `list_dir` 返回前剥掉 Windows 的 `\\?\` 前缀（见 path_safety::strip_verbatim_prefix；
    // 前端要的是可直接回传的普通形态），期望值同样按 strip 后的形态拼。
    let client_root = crate::path_safety::strip_verbatim_prefix(&canonical_root.to_string_lossy());
    let client_root = Path::new(&client_root);
    let entries = list_dir(&access, &root.to_string_lossy()).expect("列举目录");
    let mut by_name: Vec<(String, String, Option<u64>, String)> = entries
        .into_iter()
        .map(|entry| (entry.name, entry.kind, entry.size, entry.path))
        .collect();
    by_name.sort();
    assert_eq!(
        by_name,
        vec![
            (
                "note.txt".to_string(),
                "file".to_string(),
                Some(5),
                client_root.join("note.txt").to_string_lossy().into_owned()
            ),
            (
                "sub".to_string(),
                "directory".to_string(),
                None,
                client_root.join("sub").to_string_lossy().into_owned()
            ),
        ]
    );
    let _ = std::fs::remove_dir_all(root);
}

/// 越界符号链接仍不得出现在列表里（快速路径只跳过普通项的 canonicalize，
/// 链接项必须回到 `resolve_existing` 走越界校验）。
#[cfg(unix)]
#[test]
fn list_dir_drops_escaping_symlink_but_keeps_plain_entries() {
    use std::os::unix::fs::symlink;
    let root = temp_dir("listdir-symlink-root");
    let outside = temp_dir("listdir-symlink-outside");
    std::fs::write(outside.join("secret.txt"), b"secret").expect("写外部文件");
    std::fs::write(root.join("plain.txt"), b"plain").expect("写普通文件");
    std::fs::create_dir_all(root.join("sub")).expect("建子目录");
    symlink(&outside, root.join("escape")).expect("创建越界符号链接");
    // 指向授权根内部的链接：仍应出现（且给出解析后的路径）。
    symlink(root.join("sub"), root.join("inside")).expect("创建内部符号链接");

    let access = access(&root);
    let mut names: Vec<String> = list_dir(&access, &root.to_string_lossy())
        .expect("列举目录")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec!["inside", "plain.txt", "sub"],
        "越界链接应被剔除，普通项与内部链接应保留"
    );
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 宽目录列举耗时。默认 `#[ignore]`，用于性能改动前后的对比测量：
/// `cargo test --release -- --ignored --nocapture list_dir_wide_directory_timing`
#[test]
#[ignore = "性能测量用例，按需手动运行"]
fn list_dir_wide_directory_timing() {
    const ENTRIES: usize = 4000;
    let root = temp_dir("listdir-wide");
    let access = access(&root);
    for index in 0..ENTRIES {
        std::fs::write(root.join(format!("f{index:05}.txt")), b"x").expect("写文件");
    }
    let raw = root.to_string_lossy().into_owned();

    let started = std::time::Instant::now();
    let baseline = list_dir_baseline(&access, &raw).expect("旧实现列举目录");
    let baseline_elapsed = started.elapsed();

    let started = std::time::Instant::now();
    let current = list_dir(&access, &raw).expect("新实现列举目录");
    let current_elapsed = started.elapsed();

    assert_eq!(current.len(), ENTRIES);
    assert_eq!(baseline.len(), ENTRIES);
    println!(
            "list_dir {ENTRIES} 项 —— 旧(逐项 canonicalize): {baseline_elapsed:?} / 新(仅链接项解析): {current_elapsed:?}"
        );
    let _ = std::fs::remove_dir_all(root);
}

/// 改动前的实现，仅供上面的对比测量保留。
fn list_dir_baseline(access: &WorkspaceFsAccess, raw: &str) -> Result<Vec<DirEntryInfo>, String> {
    let path = access.resolve_existing(raw)?;
    let mut out = Vec::new();
    let reader = std::fs::read_dir(&path).map_err(|error| format!("打开目录失败: {error}"))?;
    for entry in reader {
        let entry = entry.map_err(|error| format!("读取目录项失败: {error}"))?;
        let entry_path = entry.path();
        let Ok(canonical) = access.resolve_existing(&entry_path.to_string_lossy()) else {
            continue;
        };
        let metadata = std::fs::metadata(&canonical)
            .map_err(|error| format!("读取目录项元数据失败: {error}"))?;
        let kind = if metadata.is_dir() {
            "directory"
        } else {
            "file"
        };
        out.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: kind.to_string(),
            size: metadata.is_file().then_some(metadata.len()),
            path: crate::path_safety::strip_verbatim_prefix(&canonical.to_string_lossy()),
        });
    }
    Ok(out)
}

#[test]
fn authorized_root_allows_binary_round_trip_and_listing() {
    let root = temp_dir("roundtrip");
    let access = access(&root);
    let path = root.join("blob.bin");
    let original: Vec<u8> = vec![0x00, 0x01, 0xFE, 0xFF, 0x50, 0x4B, 0x03, 0x04];
    let encoded = base64::engine::general_purpose::STANDARD.encode(&original);
    let write_path = access
        .resolve_write(&path.to_string_lossy())
        .expect("允许写入");
    std::fs::write(
        write_path,
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .expect("写二进制");
    let read_path = access
        .resolve_existing(&path.to_string_lossy())
        .expect("允许读取");
    assert_eq!(std::fs::read(read_path).unwrap(), original);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn media_limit_defaults_to_binary_cap_and_clamps_to_hard_cap() {
    assert_eq!(media_limit(None), DEFAULT_MEDIA_BYTES as u64);
    assert_eq!(media_limit(Some(64 * 1024 * 1024)), 64 * 1024 * 1024);
    // 渲染端报一个荒谬的额度也不能突破硬顶。
    assert_eq!(media_limit(Some(u64::MAX)), MAX_MEDIA_BYTES as u64);
}

#[test]
fn fs_read_media_reads_within_limit_and_reports_over_limit() {
    let root = temp_dir("media-read");
    let access = access(&root);
    let path = root.join("clip.mp4");
    let bytes: Vec<u8> = vec![0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70];
    std::fs::write(&path, &bytes).expect("写媒体文件");
    let raw = path.to_string_lossy().to_string();

    let read = fs_read_media(&access, raw.clone(), Some(64 * 1024 * 1024)).expect("额度内可读");
    assert_eq!(read, bytes);

    // 额度小于文件：报错并给出人话上限，而不是截断成半截文件。
    let error = fs_read_media(&access, raw, Some(4)).expect_err("超限应报错");
    assert!(error.contains("上限"), "错误应说明上限: {error}");
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn write_through_symlink_cannot_escape_authorized_root() {
    use std::os::unix::fs::symlink;
    let root = temp_dir("write-link-root");
    let outside = temp_dir("write-link-outside");
    symlink(&outside, root.join("link")).expect("创建符号链接");
    let access = access(&root);
    assert!(access
        .resolve_write(&root.join("link/new.txt").to_string_lossy())
        .is_err());
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 建一个目录联接（junction）指向 `target`。
///
/// 用 junction 而不是 symlink：`mklink /J` 不需要 SeCreateSymbolicLinkPrivilege，
/// 非管理员、未开开发者模式也能建 —— 这既是它在 Windows 上更现实的越界形态，也让用例
/// 不依赖运行者的特权。两者都是 reparse point，`std::fs::canonicalize` 走
/// GetFinalPathNameByHandle 一并解析，所以覆盖的是同一条判定路径。
#[cfg(windows)]
fn junction(target: &Path, link: &Path) {
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .expect("调用 mklink");
    assert!(
        output.status.success(),
        "创建目录联接失败: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Windows 上目录联接同样不能越出授权根（与 unix 的 symlink 用例对应）。
#[cfg(windows)]
#[test]
fn junction_cannot_escape_authorized_root() {
    let root = temp_dir("junction-root");
    let outside = temp_dir("junction-outside");
    std::fs::write(outside.join("secret.txt"), b"secret").expect("写外部文件");
    junction(&outside, &root.join("link"));
    let access = access(&root);
    assert!(access
        .resolve_existing(&root.join("link/secret.txt").to_string_lossy())
        .is_err());
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 写路径上的联接同样不能越界：`resolve_write` 会 canonicalize 最近的存在祖先。
#[cfg(windows)]
#[test]
fn write_through_junction_cannot_escape_authorized_root() {
    let root = temp_dir("junction-write-root");
    let outside = temp_dir("junction-write-outside");
    junction(&outside, &root.join("link"));
    let access = access(&root);
    assert!(access
        .resolve_write(&root.join("link/new.txt").to_string_lossy())
        .is_err());
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 探测：文本 / 二进制 / 行尾 / 越界四条一起钉住 —— 预览面板据此决定当文本还是占位。
#[test]
fn probe_reports_text_binary_and_newline_style() {
    let root = temp_dir("probe");
    let access = access(&root);

    let text = root.join("notes.txt");
    std::fs::write(&text, "第一行\r\n第二行\r\n").expect("写文本");
    let info = probe_file(&access, &text.to_string_lossy()).expect("探测文本");
    assert!(!info.binary);
    assert!(info.utf8);
    assert!(!info.bom);
    assert!(info.crlf);
    assert_eq!(info.size, "第一行\r\n第二行\r\n".len() as u64);

    let bom = root.join("bom.txt");
    std::fs::write(&bom, [0xEF, 0xBB, 0xBF, b'a']).expect("写 BOM 文件");
    let info = probe_file(&access, &bom.to_string_lossy()).expect("探测 BOM");
    assert!(info.bom);
    assert!(info.utf8);
    assert!(!info.crlf);

    let binary = root.join("blob.bin");
    std::fs::write(&binary, [0x00, 0x01, 0x02, 0x03, 0x00, 0xFF]).expect("写二进制");
    assert!(
        probe_file(&access, &binary.to_string_lossy())
            .expect("探测二进制")
            .binary
    );

    // 授权面与其它读命令一致：越界路径拿不到探测结果。
    let outside = temp_dir("probe-outside");
    let sibling = outside.join("secret.txt");
    std::fs::write(&sibling, b"secret").expect("写外部文件");
    assert!(probe_file(&access, &sibling.to_string_lossy()).is_err());
    assert!(probe_file(&access, &root.join("ghost.txt").to_string_lossy()).is_err());

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 新建：落在授权根内、撞名与非法名被拒、父目录必须存在、不覆盖既有内容。
#[test]
fn create_refuses_collisions_illegal_names_and_missing_parents() {
    let root = temp_dir("create");
    let access = access(&root);

    let file = root.join("notes.txt");
    create_file(&access, &file.to_string_lossy()).expect("新建文件");
    assert!(file.is_file());
    assert!(std::fs::read(&file).unwrap().is_empty());

    // 撞名不再新建，更不清空已有内容
    std::fs::write(&file, b"keep").unwrap();
    assert!(create_file(&access, &file.to_string_lossy()).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"keep");

    let dir = root.join("sub");
    create_dir(&access, &dir.to_string_lossy()).expect("新建文件夹");
    assert!(dir.is_dir());
    assert!(create_dir(&access, &dir.to_string_lossy()).is_err());

    // 父目录不存在（不做递归创建）
    assert!(create_file(&access, &root.join("nope/a.txt").to_string_lossy()).is_err());
    // 非法名：保留设备名 / 结尾点 / Windows ADS 的冒号
    for bad in ["CON", "foo.", "a:b"] {
        assert!(
            create_file(&access, &root.join(bad).to_string_lossy()).is_err(),
            "{bad:?} 应被拒绝"
        );
    }
    // 授权根之外 / 相对路径
    let outside = temp_dir("create-outside");
    assert!(create_file(&access, &outside.join("x.txt").to_string_lossy()).is_err());
    assert!(create_file(&access, "relative.txt").is_err());

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 改名 / 移动：同路径、撞名、自身子树、授权根、根外源全部被拒；成功时旧路径消失。
#[test]
fn rename_guards_collisions_subtrees_and_roots() {
    let root = temp_dir("rename");
    let access = access(&root);
    let dir = root.join("sub");
    std::fs::create_dir(&dir).unwrap();
    let from = dir.join("a.txt");
    std::fs::write(&from, b"one").unwrap();

    let to = dir.join("b.txt");
    rename_path(&access, &from.to_string_lossy(), &to.to_string_lossy()).expect("改名");
    assert!(!from.exists() && to.is_file());

    // 同路径
    assert!(rename_path(&access, &to.to_string_lossy(), &to.to_string_lossy()).is_err());
    // 撞名（且不能覆盖目标内容）
    std::fs::write(&from, b"two").unwrap();
    assert!(rename_path(&access, &to.to_string_lossy(), &from.to_string_lossy()).is_err());
    assert_eq!(std::fs::read(&from).unwrap(), b"two");

    // 目录挪进自己的子树
    assert!(rename_path(
        &access,
        &dir.to_string_lossy(),
        &dir.join("inner/sub").to_string_lossy()
    )
    .is_err());

    // 跨目录移动
    let moved = root.join("b.txt");
    rename_path(&access, &to.to_string_lossy(), &moved.to_string_lossy()).expect("移动");
    assert!(moved.is_file() && !to.exists());

    // 授权根本身
    let outer = temp_dir("rename-outer");
    assert!(rename_path(
        &access,
        &root.to_string_lossy(),
        &outer.join("renamed").to_string_lossy()
    )
    .is_err());
    // 根之外的源
    let outside = temp_dir("rename-outside");
    let ghost = outside.join("x.txt");
    std::fs::write(&ghost, b"x").unwrap();
    assert!(rename_path(
        &access,
        &ghost.to_string_lossy(),
        &root.join("x.txt").to_string_lossy()
    )
    .is_err());

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
    let _ = std::fs::remove_dir_all(outer);
}

/// 复制：目录递归；目录内的符号链接被跳过（不把根外内容搬进来）；链接源被明确拒绝。
#[test]
fn copy_is_recursive_and_skips_symlinked_entries() {
    let root = temp_dir("copy");
    let access = access(&root);
    let src = root.join("src");
    std::fs::create_dir_all(src.join("nested")).unwrap();
    std::fs::write(src.join("a.txt"), b"a").unwrap();
    std::fs::write(src.join("nested/b.txt"), b"b").unwrap();

    let dst = root.join("dst");
    copy_path(&access, &src.to_string_lossy(), &dst.to_string_lossy()).expect("复制目录");
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"a");
    assert_eq!(std::fs::read(dst.join("nested/b.txt")).unwrap(), b"b");

    // 撞名 / 复制进自己内部
    assert!(copy_path(&access, &src.to_string_lossy(), &dst.to_string_lossy()).is_err());
    assert!(copy_path(
        &access,
        &src.to_string_lossy(),
        &src.join("inner").to_string_lossy()
    )
    .is_err());

    #[cfg(unix)]
    {
        let outside = temp_dir("copy-outside");
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), src.join("link.txt")).unwrap();

        let dst2 = root.join("dst2");
        copy_path(&access, &src.to_string_lossy(), &dst2.to_string_lossy())
            .expect("复制目录（含链接）");
        assert!(!dst2.join("link.txt").exists(), "链接不该被复制过去");

        // 源自身是链接：拒绝而不是跟随到目标
        let linked = root.join("linked.txt");
        std::os::unix::fs::symlink(src.join("a.txt"), &linked).unwrap();
        assert!(copy_path(
            &access,
            &linked.to_string_lossy(),
            &root.join("copied.txt").to_string_lossy()
        )
        .is_err());

        let _ = std::fs::remove_dir_all(outside);
    }

    let _ = std::fs::remove_dir_all(root);
}

/// 删除：文件与目录（递归）都能删；授权根、文件系统根、根外被拒；软链删的是链接本身。
#[test]
fn delete_rejects_roots_and_removes_entries() {
    let root = temp_dir("delete");
    let access = access(&root);
    let file = root.join("a.txt");
    std::fs::write(&file, b"a").unwrap();
    let dir = root.join("d");
    std::fs::create_dir_all(dir.join("inner")).unwrap();
    std::fs::write(dir.join("inner/b.txt"), b"b").unwrap();

    delete_path(&access, &file.to_string_lossy()).expect("删文件");
    assert!(!file.exists());
    delete_path(&access, &dir.to_string_lossy()).expect("删目录");
    assert!(!dir.exists());

    assert!(
        delete_path(&access, &root.to_string_lossy()).is_err(),
        "授权根不可删"
    );
    assert!(delete_path(&access, "/").is_err(), "文件系统根不可删");
    let outside = temp_dir("delete-outside");
    let ghost = outside.join("x.txt");
    std::fs::write(&ghost, b"x").unwrap();
    assert!(delete_path(&access, &ghost.to_string_lossy()).is_err());
    assert!(ghost.exists(), "越界删除不该真的删掉");

    #[cfg(unix)]
    {
        let target = root.join("target.txt");
        std::fs::write(&target, b"keep").unwrap();
        let link = root.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        delete_path(&access, &link.to_string_lossy()).expect("删软链");
        assert!(
            std::fs::symlink_metadata(&link).is_err(),
            "链接条目应被删掉"
        );
        assert!(target.exists(), "目标文件必须还在");
    }

    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::remove_dir_all(outside);
}

/// 非 ASCII 名称往返：新建 → 改名 → 复制 → 删除。
#[test]
fn crud_round_trips_non_ascii_names() {
    let root = temp_dir("unicode");
    let access = access(&root);

    let created = root.join("报告 2026.txt");
    create_file(&access, &created.to_string_lossy()).expect("新建中文名文件");

    let renamed = root.join("总结.md");
    rename_path(
        &access,
        &created.to_string_lossy(),
        &renamed.to_string_lossy(),
    )
    .expect("改名");
    assert!(renamed.is_file());

    let copied = root.join("总结 副本.md");
    copy_path(
        &access,
        &renamed.to_string_lossy(),
        &copied.to_string_lossy(),
    )
    .expect("复制");
    assert!(copied.is_file());

    delete_path(&access, &renamed.to_string_lossy()).expect("删除");
    assert!(!renamed.exists() && copied.exists());

    let _ = std::fs::remove_dir_all(root);
}

/// 跨设备降级：内容整棵搬过去，源被删掉。直接测降级函数本身 —— 单元测试里造不出
/// 第二个挂载点，而这段逻辑与真实设备无关（只有 EXDEV 触发时机依赖设备）。
#[test]
fn move_across_devices_copies_then_removes_source() {
    let root = temp_dir("xdev");
    let source = root.join("src");
    std::fs::create_dir_all(source.join("nested")).expect("建源目录");
    std::fs::write(source.join("a.txt"), "hello").expect("写 a");
    std::fs::write(source.join("nested/b.txt"), "world").expect("写 b");
    let target = root.join("dst");

    move_across_devices(&source, &target).expect("跨设备移动降级");

    assert!(!source.exists(), "源应已删除");
    assert_eq!(
        std::fs::read_to_string(target.join("a.txt")).expect("读 a"),
        "hello"
    );
    assert_eq!(
        std::fs::read_to_string(target.join("nested/b.txt")).expect("读 b"),
        "world"
    );
    let _ = std::fs::remove_dir_all(root);
}

/// 目录内含符号链接时拒绝降级，且源保持原样（不静默丢链接）。
#[cfg(unix)]
#[test]
fn move_across_devices_refuses_directory_with_symlink() {
    use std::os::unix::fs::symlink;
    let root = temp_dir("xdev-link");
    let source = root.join("src");
    std::fs::create_dir_all(&source).expect("建源目录");
    std::fs::write(source.join("a.txt"), "hi").expect("写 a");
    symlink("a.txt", source.join("link.txt")).expect("建链接");
    let target = root.join("dst");

    let error = move_across_devices(&source, &target).expect_err("含链接应拒绝");
    assert!(error.contains("符号链接"), "{error}");
    assert!(source.exists(), "拒绝时源必须原样保留");
    assert!(!target.exists(), "拒绝时不该留下目标");
    let _ = std::fs::remove_dir_all(root);
}

/// 源本身是符号链接同样拒绝（`copy_entry` 对链接是空操作，删源会直接把链接抹掉）。
#[cfg(unix)]
#[test]
fn move_across_devices_refuses_symlink_source() {
    use std::os::unix::fs::symlink;
    let root = temp_dir("xdev-self-link");
    std::fs::write(root.join("real.txt"), "data").expect("写实体文件");
    let link = root.join("link.txt");
    symlink("real.txt", &link).expect("建链接");
    let target = root.join("dst");

    let error = move_across_devices(&link, &target).expect_err("链接源应拒绝");
    assert!(error.contains("符号链接"), "{error}");
    assert!(std::fs::symlink_metadata(&link).is_ok(), "链接应仍在");
    assert!(root.join("real.txt").exists(), "链接目标应未被牵连");
    let _ = std::fs::remove_dir_all(root);
}

/// 跨设备判定按平台 errno：Unix 认 EXDEV(18)，Windows 认 ERROR_NOT_SAME_DEVICE(17)。
#[test]
fn is_cross_device_matches_platform_errno() {
    #[cfg(unix)]
    assert!(is_cross_device(&std::io::Error::from_raw_os_error(18)));
    #[cfg(windows)]
    assert!(is_cross_device(&std::io::Error::from_raw_os_error(17)));
    // 无关 errno（ENOENT）不应被误判成跨设备。
    assert!(!is_cross_device(&std::io::Error::from_raw_os_error(2)));
}
