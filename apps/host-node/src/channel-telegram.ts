/**
 * Telegram 通道：Bot API（HTTPS + JSON），长轮询收信、Bot API 发信。
 * 移植 `channels/telegram/` 的核心语义：凭据落盘 0600、connect/disconnect/send/status。
 * 完整的事件分类（文本 / 图片 / 文件 / 回调按钮）与媒体收发在后续批次补齐。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

export const TG_API = "https://api.telegram.org/bot";

interface TgCredentials {
  botToken: string;
}

function credentialsDir(dataDir: string): string {
  return path.join(dataDir, "telegram");
}

function credentialsFile(dataDir: string): string {
  return path.join(credentialsDir(dataDir), "credentials.json");
}

export function saveCredentials(dataDir: string, botToken: string): void {
  mkdirSync(credentialsDir(dataDir), { recursive: true });
  writeFileSync(credentialsFile(dataDir), JSON.stringify({ botToken }), { mode: 0o600 });
}

export function loadCredentials(dataDir: string): TgCredentials | null {
  try {
    const raw = JSON.parse(readFileSync(credentialsFile(dataDir), "utf8")) as TgCredentials;
    return typeof raw.botToken === "string" && raw.botToken !== "" ? raw : null;
  } catch { return null; }
}

export function clearCredentials(dataDir: string): void {
  rmSync(credentialsDir(dataDir), { recursive: true, force: true });
}
