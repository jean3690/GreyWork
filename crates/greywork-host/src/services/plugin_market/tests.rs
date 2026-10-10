use sha2::{Digest, Sha256};

use super::dto::{
    CapabilityRequirement, CodePluginRuntime, DeclarativeAction, DeclarativeContributions,
    DeclarativeField, DeclarativeMode, DeclarativeOperation, DeclarativeOutput, DeclarativePage,
    MarketPluginManifest, MarketRegionAction, MarketUiRegionContribution, PluginKind,
    PluginPackage, PluginRegistry, PluginRegistryEntry, PluginWindowDecl, RenderLoop,
};
use super::install::{install_package_at, list_installed_at};
use super::net_fetch::validate_plugin_fetch_url;
use super::package::validate_package;
use super::registry::{
    hex_decode_32, is_official_registry_url, validate_registry, verify_registry_signature_with,
};
use super::validate::{validate_dir_key, validate_github_url, validate_key};
use super::{OFFICIAL_REGISTRY_PUBLIC_KEY, OFFICIAL_REGISTRY_URL};

fn demo_package() -> PluginPackage {
    PluginPackage {
        schema_version: 1,
        manifest: MarketPluginManifest {
            id: "demo.counter".into(),
            name: "Demo Counter".into(),
            version: "1.0.0".into(),
            description: None,
            kind: PluginKind::Declarative,
            runtime: None,
            requires: vec![CapabilityRequirement::Plain("demo:run".into())],
            window: None,
            contributes: DeclarativeContributions {
                modes: vec![DeclarativeMode {
                    id: "demo-counter".into(),
                    title: "Demo".into(),
                    icon: Some("lightning".into()),
                    page: DeclarativePage {
                        eyebrow: Some("Marketplace plugin".into()),
                        heading: "Demo plugin is running".into(),
                        body: "Loaded from a declarative package.".into(),
                        fields: vec![DeclarativeField {
                            key: "count".into(),
                            label: "Count".into(),
                            description: None,
                            kind: "number".into(),
                            default: serde_json::json!(0),
                            min: Some(0.0),
                            max: Some(100.0),
                            step: Some(1.0),
                            max_length: None,
                        }],
                        outputs: vec![DeclarativeOutput {
                            label: "Current count".into(),
                            value_key: "count".into(),
                            suffix: None,
                        }],
                        actions: vec![DeclarativeAction {
                            id: "increment".into(),
                            label: "Add one".into(),
                            style: Some("primary".into()),
                            operation: DeclarativeOperation::Increment {
                                key: "count".into(),
                                amount: Some(1.0),
                            },
                        }],
                    },
                }],
                ui_regions: Vec::new(),
            },
        },
        code: None,
    }
}

#[test]
fn validates_github_only_registry_urls() {
    assert!(validate_github_url(
        "https://raw.githubusercontent.com/acme/plugins/main/registry.json"
    )
    .is_ok());
    assert!(validate_github_url(
        "http://raw.githubusercontent.com/acme/plugins/main/registry.json"
    )
    .is_err());
    assert!(validate_github_url("https://example.com/registry.json").is_err());
}

#[test]
fn official_registry_url_detection_is_normalized() {
    // 官方 URL 的各种变体（大小写 host / 结尾斜杠 / query / fragment）都算官方源。
    for variant in [
        OFFICIAL_REGISTRY_URL,
        "https://RAW.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json",
        "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json/",
        "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json?ref=main",
        "  https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json  ",
    ] {
        assert!(
            is_official_registry_url(variant),
            "expected official: {variant}"
        );
    }
    // 非官方源（不同仓库 / 不同 host / 非法 URL）不算官方。
    for variant in [
        "https://raw.githubusercontent.com/someone/other-market/main/registry.json",
        "https://example.com/registry.json",
        "not a url",
    ] {
        assert!(
            !is_official_registry_url(variant),
            "expected third-party: {variant}"
        );
    }
}

#[test]
fn official_registry_signature_is_mandatory_even_for_url_variants() {
    // 官方源经变体 URL 访问时，缺签名仍必须拒绝（防降级为第三方免签）。
    let registry = PluginRegistry {
        schema_version: 1,
        plugins: Vec::new(),
        signature: None,
    };
    assert!(validate_registry(&registry, OFFICIAL_REGISTRY_URL).is_err());
    assert!(validate_registry(
        &registry,
        "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json/"
    )
    .is_err());
}

#[test]
fn window_declaration_requires_the_floating_capability() {
    // worker + render + window，但 requires 未声明 window.floating：拒绝。
    let mut package = demo_package();
    package.manifest.kind = PluginKind::Worker;
    package.manifest.runtime = Some(CodePluginRuntime {
        runtime_type: "worker".into(),
        entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
        sha256: "a".repeat(64),
        render: Some(RenderLoop {
            handler: "draw".into(),
            fps: Some(12),
            width: Some(160),
            height: Some(140),
        }),
    });
    package.manifest.window = Some(PluginWindowDecl {
        width: 160,
        height: 140,
    });
    assert!(validate_package(&package).is_err());

    // 声明 window.floating 后通过。
    package.manifest.requires = vec![CapabilityRequirement::Plain("window.floating".into())];
    assert!(validate_package(&package).is_ok());
}

#[test]
fn rejects_invalid_or_executable_shapes() {
    let mut package = demo_package();
    package.manifest.id = "../escape".into();
    assert!(validate_package(&package).is_err());

    let mut package = demo_package();
    package.manifest.contributes.modes[0].id = "UPPER".into();
    assert!(validate_package(&package).is_err());
}

#[test]
fn validate_dir_key_rejects_windows_path_escapes() {
    assert!(validate_dir_key("demo.counter", "plugin id").is_ok());
    assert!(validate_dir_key("advance", "action id").is_ok());

    // 盘符相对路径：`install_package_at` 会 `root.join(id)`，冒号必须拒
    assert!(validate_dir_key("c:evil", "plugin id").is_err());
    assert!(validate_dir_key("c:", "plugin id").is_err());
    assert!(validate_dir_key("a:b", "plugin id").is_err());
    // Win32 保留设备名与结尾点
    assert!(validate_dir_key("con", "plugin id").is_err());
    assert!(validate_dir_key("nul.txt", "plugin id").is_err());
    assert!(validate_dir_key("foo.", "plugin id").is_err());

    // 但能力名允许冒号（随包 registry 里的 `demo:run`），不能被误伤
    assert!(validate_key("demo:run", "required capability").is_ok());
}

#[test]
fn worker_packages_require_a_pinned_github_entry_and_allow_invoke_actions() {
    let mut package = demo_package();
    package.manifest.kind = PluginKind::Worker;
    package.manifest.runtime = Some(CodePluginRuntime {
        runtime_type: "worker".into(),
        entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
        sha256: "a".repeat(64),
        render: None,
    });
    package.manifest.contributes.modes[0].page.actions[0].operation =
        DeclarativeOperation::Invoke {
            handler: "increment".into(),
        };
    assert!(validate_package(&package).is_ok());

    package.manifest.runtime.as_mut().unwrap().entry = "https://example.com/demo.js".into();
    assert!(validate_package(&package).is_err());
}

#[test]
fn ui_region_contributions_require_worker_render_and_bounded_shape() {
    // 基础 worker + render 包。
    let worker_with_region = |regions: Vec<MarketUiRegionContribution>| {
        let mut package = demo_package();
        package.manifest.kind = PluginKind::Worker;
        package.manifest.runtime = Some(CodePluginRuntime {
            runtime_type: "worker".into(),
            entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
            sha256: "a".repeat(64),
            render: Some(RenderLoop {
                handler: "draw".into(),
                fps: Some(12),
                width: Some(160),
                height: Some(140),
            }),
        });
        package.manifest.contributes.ui_regions = regions;
        package
    };
    let region = |id: &str, region_name: &str| MarketUiRegionContribution {
        region: region_name.into(),
        id: id.into(),
        title: "宠物".into(),
        order: Some(5),
        overflow: None,
        width: Some(160),
        height: Some(140),
        actions: vec![MarketRegionAction {
            id: "feed".into(),
            label: "喂食".into(),
        }],
    };

    // 合法：shellSidebar + worker render。
    assert!(validate_package(&worker_with_region(vec![region("pet", "shellSidebar")])).is_ok());

    // 声明式包带 uiRegion：拒绝。
    let mut declarative = demo_package();
    declarative.manifest.contributes.ui_regions = vec![region("pet", "shellSidebar")];
    assert!(validate_package(&declarative).is_err());

    // worker 无 render 循环：拒绝。
    let mut no_render = worker_with_region(vec![region("pet", "shellSidebar")]);
    no_render.manifest.runtime.as_mut().unwrap().render = None;
    assert!(validate_package(&no_render).is_err());

    // 未知区域：拒绝。
    assert!(validate_package(&worker_with_region(vec![region("pet", "titlebar")])).is_err());

    // 超尺寸 / 动作超限 / 重复 id：拒绝。
    let mut oversized = worker_with_region(vec![region("pet", "shellSidebar")]);
    oversized.manifest.contributes.ui_regions[0].width = Some(600);
    assert!(validate_package(&oversized).is_err());

    let mut too_many_actions = worker_with_region(vec![region("pet", "shellSidebar")]);
    too_many_actions.manifest.contributes.ui_regions[0].actions = (0..5)
        .map(|index| MarketRegionAction {
            id: format!("a{index}"),
            label: "x".into(),
        })
        .collect();
    assert!(validate_package(&too_many_actions).is_err());

    let duplicated = worker_with_region(vec![
        region("pet", "shellSidebar"),
        region("pet", "activityPanel"),
    ]);
    assert!(validate_package(&duplicated).is_err());
}

#[test]
fn render_loop_validation_bounds_handler_fps_and_canvas() {
    let worker_with_render = |render: Option<RenderLoop>| {
        let mut package = demo_package();
        package.manifest.kind = PluginKind::Worker;
        package.manifest.runtime = Some(CodePluginRuntime {
            runtime_type: "worker".into(),
            entry: "https://raw.githubusercontent.com/acme/plugins/main/demo.js".into(),
            sha256: "a".repeat(64),
            render,
        });
        package
    };

    // 合法 render：handler + 默认 fps/画布。
    let ok = worker_with_render(Some(RenderLoop {
        handler: "draw".into(),
        fps: None,
        width: None,
        height: None,
    }));
    assert!(validate_package(&ok).is_ok());

    // fps 越界（0 / 61）拒绝；合法（1-60）通过。
    let mut bad_fps = worker_with_render(Some(RenderLoop {
        handler: "draw".into(),
        fps: Some(0),
        width: None,
        height: None,
    }));
    assert!(validate_package(&bad_fps).is_err());
    bad_fps
        .manifest
        .runtime
        .as_mut()
        .unwrap()
        .render
        .as_mut()
        .unwrap()
        .fps = Some(61);
    assert!(validate_package(&bad_fps).is_err());
    bad_fps
        .manifest
        .runtime
        .as_mut()
        .unwrap()
        .render
        .as_mut()
        .unwrap()
        .fps = Some(30);
    assert!(validate_package(&bad_fps).is_ok());

    // 画布越界（0 / >512）拒绝。
    let mut bad_size = worker_with_render(Some(RenderLoop {
        handler: "draw".into(),
        fps: None,
        width: Some(0),
        height: Some(100),
    }));
    assert!(validate_package(&bad_size).is_err());
    bad_size
        .manifest
        .runtime
        .as_mut()
        .unwrap()
        .render
        .as_mut()
        .unwrap()
        .width = Some(600);
    assert!(validate_package(&bad_size).is_err());

    // handler key 非法（大写/空）。
    let bad_handler = worker_with_render(Some(RenderLoop {
        handler: "Draw".into(),
        fps: None,
        width: None,
        height: None,
    }));
    assert!(validate_package(&bad_handler).is_err());
}

#[test]
fn rejects_actions_and_outputs_with_invalid_field_references() {
    let mut package = demo_package();
    package.manifest.contributes.modes[0].page.outputs[0].value_key = "missing".into();
    assert!(validate_package(&package).is_err());

    let mut package = demo_package();
    package.manifest.contributes.modes[0].page.actions[0].operation =
        DeclarativeOperation::Increment {
            key: "missing".into(),
            amount: Some(1.0),
        };
    assert!(validate_package(&package).is_err());

    let mut package = demo_package();
    package.manifest.contributes.modes[0].page.fields[0].default =
        serde_json::json!("not a number");
    assert!(validate_package(&package).is_err());
}

#[test]
fn installs_lists_updates_and_uninstalls_inside_root() {
    let root = std::env::temp_dir().join(format!("gw-plugin-market-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let package = demo_package();
    let installed = install_package_at(&root, &package).expect("install succeeds");
    assert!(installed.ends_with("demo.counter/plugin.json"));
    let listed = list_installed_at(&root).expect("list succeeds");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].manifest.id, "demo.counter");

    let mut updated = package;
    updated.manifest.version = "1.1.0".into();
    install_package_at(&root, &updated).expect("update succeeds");
    assert_eq!(
        list_installed_at(&root).unwrap()[0].manifest.version,
        "1.1.0"
    );
    std::fs::remove_dir_all(root.join("demo.counter")).unwrap();
    assert!(list_installed_at(&root).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn net_fetch_requirements_require_a_valid_host_allowlist() {
    // 无 hosts 白名单的字符串形态：拒绝。
    let mut package = demo_package();
    package.manifest.requires = vec![CapabilityRequirement::Plain("net.fetch".into())];
    assert!(validate_package(&package).is_err());

    // 参数化形态 + 合法 hosts：通过。
    let mut package = demo_package();
    package.manifest.requires = vec![CapabilityRequirement::Parameterized {
        capability: "net.fetch".into(),
        hosts: vec!["api.github.com".into(), "example.org".into()],
    }];
    assert!(validate_package(&package).is_ok());

    // 越权：net.fetch 之外的能力不接受参数。
    let mut package = demo_package();
    package.manifest.requires = vec![CapabilityRequirement::Parameterized {
        capability: "plugin-admin".into(),
        hosts: vec!["api.github.com".into()],
    }];
    assert!(validate_package(&package).is_err());

    // 非法 host：协议 / 通配 / 单标签。
    for host in ["https://api.github.com", "*.github.com", "localhost"] {
        let mut package = demo_package();
        package.manifest.requires = vec![CapabilityRequirement::Parameterized {
            capability: "net.fetch".into(),
            hosts: vec![host.into()],
        }];
        assert!(
            validate_package(&package).is_err(),
            "host {host} should be rejected"
        );
    }
}

#[test]
fn plugin_net_fetch_url_validation_enforces_https_and_host_allowlist() {
    let allow = vec!["api.github.com".to_string(), "example.org".to_string()];
    // 白名单内（含子域）：通过。
    assert!(validate_plugin_fetch_url("https://api.github.com/meta", &allow).is_ok());
    assert!(validate_plugin_fetch_url("https://www.example.org/", &allow).is_ok());
    // 白名单外：拒绝。
    assert!(validate_plugin_fetch_url("https://evil.com/", &allow).is_err());
    // 后缀伪造：允许 example.org 不等于允许 notexample.org。
    assert!(validate_plugin_fetch_url("https://notexample.org/", &allow).is_err());
    // 非 https / 内嵌凭据 / 空白名单：拒绝。
    assert!(validate_plugin_fetch_url("http://api.github.com/", &allow).is_err());
    assert!(validate_plugin_fetch_url("https://user:pass@api.github.com/", &allow).is_err());
    assert!(validate_plugin_fetch_url("https://api.github.com/", &[]).is_err());
}

#[test]
fn registry_signature_policy_official_missing_forged_and_valid() {
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};

    fn registry_with(signature: Option<String>) -> PluginRegistry {
        PluginRegistry {
            schema_version: 1,
            plugins: vec![PluginRegistryEntry {
                id: "demo.counter".into(),
                name: "Demo Counter".into(),
                version: "1.0.0".into(),
                description: None,
                author: None,
                download_url: "https://raw.githubusercontent.com/acme/plugins/main/demo.json"
                    .into(),
                sha256: "a".repeat(64),
            }],
            signature,
        }
    }

    // RFC 8032 测试向量私钥（公钥 3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c）。
    let signing_key = SigningKey::from_bytes(
        &hex_decode_32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60").unwrap(),
    );
    let public_key_bytes = signing_key.verifying_key().to_bytes();
    let official_url =
        "https://raw.githubusercontent.com/jean3690/greywork-plugin-market/main/registry.json";
    let third_party_url =
        "https://raw.githubusercontent.com/someone/other-market/main/registry.json";

    // 签名消息 = 去掉 signature 字段后的规范化 JSON（与 verify 端约定一致）。
    let message = serde_json::to_vec(&registry_with(None)).unwrap();
    let good_signature =
        base64::engine::general_purpose::STANDARD.encode(signing_key.sign(&message).to_bytes());

    // 1) 官方源 + 缺签名：拒绝。
    assert!(validate_registry(&registry_with(None), official_url).is_err());
    // 2) 自建源 + 缺签名：放行（用户自担）。
    assert!(validate_registry(&registry_with(None), third_party_url).is_ok());

    // 3) 伪造签名（攻击者私钥）：对任意 URL 都拒绝。
    let mut attacker_seed = [0u8; 32];
    attacker_seed[0] = 1;
    let attacker_key = SigningKey::from_bytes(&attacker_seed);
    let forged =
        base64::engine::general_purpose::STANDARD.encode(attacker_key.sign(&message).to_bytes());
    assert!(
        verify_registry_signature_with(&registry_with(Some(forged)), &public_key_bytes).is_err()
    );

    // 4) 正确签名（对注入公钥）：验签通过。
    assert!(verify_registry_signature_with(
        &registry_with(Some(good_signature.clone())),
        &public_key_bytes
    )
    .is_ok());

    // 5) 内容篡改：签名后改 plugins 内容 → 验签失败。
    let mut tampered = registry_with(Some(good_signature));
    tampered.plugins[0].version = "9.9.9".into();
    assert!(verify_registry_signature_with(&tampered, &public_key_bytes).is_err());

    // 6) 非法 base64 / 错误长度。
    assert!(verify_registry_signature_with(
        &registry_with(Some("!!!not-base64!!!".into())),
        &public_key_bytes
    )
    .is_err());
    assert!(
        verify_registry_signature_with(&registry_with(Some("AAAA".into())), &public_key_bytes)
            .is_err()
    );
}

#[test]
fn shipped_registry_verifies_against_host_public_key() {
    // 端到端信任链自检：plugin-market/registry.json 的签名必须能被
    // 宿主硬编码公钥验过 —— 防止签名脚本与 Rust 验签端规范化不一致。
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugin-market/registry.json"
    );
    let Ok(bytes) = std::fs::read(path) else {
        // 仓库外构建（单独打包本 crate）跳过。
        return;
    };
    let registry: PluginRegistry = serde_json::from_slice(&bytes).expect("registry parses");
    let public_key = hex_decode_32(OFFICIAL_REGISTRY_PUBLIC_KEY).expect("host key decodes");
    verify_registry_signature_with(&registry, &public_key)
        .expect("shipped registry signature verifies");
}

#[test]
fn shipped_market_packages_pass_validation() {
    // 市场目录内所有包必须过 validate_package + 与 registry 条目身份一致 ——
    // 发布前忘了重算 sha256 / 改坏了 schema 在这里炸，而不是用户安装时。
    let market_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../plugin-market");
    let registry_path = format!("{market_dir}/registry.json");
    let Ok(registry_bytes) = std::fs::read(&registry_path) else {
        return;
    };
    let registry: PluginRegistry =
        serde_json::from_slice(&registry_bytes).expect("registry parses");
    for entry in &registry.plugins {
        let file_name = entry
            .download_url
            .rsplit('/')
            .next()
            .expect("download url has file name");
        let bytes = std::fs::read(format!("{market_dir}/packages/{file_name}"))
            .unwrap_or_else(|_| panic!("package file exists: {file_name}"));
        let package: PluginPackage = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| panic!("package parses: {file_name}"));
        validate_package(&package)
            .unwrap_or_else(|error| panic!("package validates ({file_name}): {error}"));
        assert_eq!(package.manifest.id, entry.id, "package id matches registry");
        assert_eq!(
            package.manifest.version, entry.version,
            "package version matches registry"
        );
        let actual_hash = format!("{:x}", Sha256::digest(&bytes));
        assert_eq!(
            actual_hash, entry.sha256,
            "package sha256 matches registry ({file_name})"
        );
    }
}
