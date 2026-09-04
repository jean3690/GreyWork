/**
 * 远端会话落盘配置（浏览器态）。
 *
 * 桌面态的真源是本地文件（Rust store_fs）；浏览器态没有磁盘通道，只能把会话
 * 推到一个 HTTP 可写的目录上 —— 这里用 WebDAV，因为它是「一个目录 + 基本认证」
 * 就能起来的最小协议：自建 nginx/Apache/Nextcloud，或把本地挂载目录（NFS、
 * rclone mount、局域网盘）用任意 WebDAV 服务端暴露出来，都是同一条路径。
 *
 * 安全含义：**凭据以明文存在 localStorage**（浏览器态没有系统钥匙串通道）。
 * 只适合自建/局域网端点，并且应当用一个只对该目录有权限的专用账号，
 * 不要填复用的主账号口令。
 */

import { createJsonStorage } from "@greywork/core";

const STORAGE_KEY = "greywork.remote-store";

export interface RemoteStoreConfig {
  /** off = 不落远端（仅 localStorage）；webdav = 推到 WebDAV 目录。 */
  kind: "off" | "webdav";
  /** WebDAV 基址（指向存放会话的目录，如 https://dav.example.com/greywork）。 */
  url: string;
  username?: string;
  password?: string;
}

export const REMOTE_STORE_OFF: RemoteStoreConfig = { kind: "off", url: "" };

const storage = createJsonStorage<RemoteStoreConfig>(STORAGE_KEY, (value): value is RemoteStoreConfig => {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || !("url" in value)) return false;
  return (value.kind === "off" || value.kind === "webdav") && typeof value.url === "string";
});

export function readRemoteStoreConfig(): RemoteStoreConfig {
  return storage.read() ?? REMOTE_STORE_OFF;
}

export function writeRemoteStoreConfig(config: RemoteStoreConfig): void {
  storage.write({
    kind: config.kind,
    url: config.url.trim().replace(/\/+$/, ""),
    username: config.username?.trim() || undefined,
    password: config.password || undefined,
  });
}

/** 是否真的有远端可写（kind 选了 webdav 且填了地址）。 */
export function isRemoteStoreEnabled(config: RemoteStoreConfig): boolean {
  return config.kind === "webdav" && config.url.trim().length > 0;
}
