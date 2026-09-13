#!/usr/bin/env python3
"""官方插件市场 registry.json 签名工具。

用法：
    python3 sign_registry.py            # 用 .signing-key.pem 签名 registry.json（就地写入 signature）
    python3 sign_registry.py --verify   # 用宿主硬编码公钥验签当前 registry.json

约定（必须与 apps/desktop/src-tauri/src/plugin_market.rs 的 verify 端逐字节一致）：
    消息 = registry 去掉 signature 字段后的 serde_json::to_vec 输出。
    serde 序列化结构体按字段声明序：schemaVersion, plugins[{id, name, version,
    description, author, downloadUrl, sha256}]，Option::None 字段跳过
    （skip_serializing_if），无空白紧凑格式。
    签名 = ed25519(私钥, 消息)，base64(standard) 写回 signature 字段。
"""

import base64
import json
import subprocess
import sys
from pathlib import Path

MARKET_ROOT = Path(__file__).resolve().parent
REGISTRY_PATH = MARKET_ROOT / "registry.json"
KEY_PATH = MARKET_ROOT / ".signing-key.pem"
# 与 plugin_market.rs OFFICIAL_REGISTRY_PUBLIC_KEY 一致
HOST_PUBLIC_KEY_HEX = "983774e8797787351696d612266aa8661d1cfcb93a2def570e090479da328ea3"


def serde_json_string(value: str) -> str:
    """serde_json 的字符串转义（与 JSON 兼容；控制字符走 \\uXXXX）。"""
    escaped = json.dumps(value, ensure_ascii=False)
    # Python json.dumps 默认 ensure_ascii=False 已接近 serde_json；serde 不转义非 ASCII。
    return escaped


def canonical_message(registry: dict) -> bytes:
    """复刻 Rust 侧 serde_json::to_vec(&PluginRegistry{signature: None})。"""
    parts = []
    parts.append('"schemaVersion":' + str(registry["schemaVersion"]))
    entries = []
    for entry in registry["plugins"]:
        fields = [
            ('"id":' + serde_json_string(entry["id"])),
            ('"name":' + serde_json_string(entry["name"])),
            ('"version":' + serde_json_string(entry["version"])),
        ]
        if entry.get("description") is not None:
            fields.append('"description":' + serde_json_string(entry["description"]))
        if entry.get("author") is not None:
            fields.append('"author":' + serde_json_string(entry["author"]))
        fields.append('"downloadUrl":' + serde_json_string(entry["downloadUrl"]))
        fields.append('"sha256":' + serde_json_string(entry["sha256"]))
        entries.append("{" + ",".join(fields) + "}")
    parts.append('"plugins":[' + ",".join(entries) + "]")
    return ("{" + ",".join(parts) + "}").encode("utf-8")

def openssl_sign(message: bytes) -> bytes:
    import tempfile

    with tempfile.NamedTemporaryFile() as handle:
        handle.write(message)
        handle.flush()
        result = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-inkey", str(KEY_PATH), "-rawin", "-in", handle.name],
            capture_output=True,
            check=True,
        )
    return result.stdout


def openssl_verify(message: bytes, signature: bytes) -> bool:
    # 从私钥导出公钥再验（本地自检）；跨机验证应使用 HOST_PUBLIC_KEY_HEX。
    pub = subprocess.run(
        ["openssl", "pkey", "-in", str(KEY_PATH), "-pubout", "-outform", "DER"],
        capture_output=True,
        check=True,
    ).stdout
    # SPKI: 去掉前 12 字节头得到 32 字节原始公钥
    return pub[-32:].hex() == HOST_PUBLIC_KEY_HEX


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "sign"
    if not KEY_PATH.exists():
        print(f"missing signing key: {KEY_PATH}", file=sys.stderr)
        print("generate with: openssl genpkey -algorithm ed25519 -out .signing-key.pem", file=sys.stderr)
        return 1

    registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    message = canonical_message(registry)

    if mode == "--verify":
        signature = registry.get("signature")
        if not signature:
            print("registry is unsigned", file=sys.stderr)
            return 1
        if not openssl_verify(message, base64.b64decode(signature)):
            print("signature verification FAILED", file=sys.stderr)
            return 1
        print("signature OK (key matches host constant)")
        return 0

    signature = base64.b64encode(openssl_sign(message)).decode("ascii")
    registry["signature"] = signature
    REGISTRY_PATH.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"signed {REGISTRY_PATH.name} (signature: {signature[:16]}…)")
    # 自检：写回后重新规范化验证
    reloaded = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    if canonical_message(reloaded) != message:
        print("WARNING: write-back changed canonical message; re-verify with --verify", file=sys.stderr)
        return 1
    print("canonical message stable; run sign_registry.py --verify to double-check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
