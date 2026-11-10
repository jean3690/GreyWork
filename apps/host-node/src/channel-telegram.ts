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
    // Rust 侧落盘形状是 { token }；Node 早期版本是 { botToken }，两者都认。
    const raw = JSON.parse(readFileSync(credentialsFile(dataDir), "utf8")) as { token?: unknown; botToken?: unknown };
    const botToken = typeof raw.token === "string" && raw.token !== "" ? raw.token : typeof raw.botToken === "string" ? raw.botToken : null;
    return botToken !== null ? { botToken } : null;
  } catch {
    return null;
  }
}

export function clearCredentials(dataDir: string): void {
  rmSync(credentialsDir(dataDir), { recursive: true, force: true });
}

/* ===== 通道命令 ===== */

/** 已配置的 bot token（credentials 存在且非空）。 */
export function telegramStatus(dataDir: string): { configured: boolean; connected: boolean } {
  return { configured: loadCredentials(dataDir) !== null, connected: false };
}

/**
 * 发消息：调 Telegram Bot API `sendMessage`。
 * Rust 侧的 send 还会触发 `telegram://message` 事件（入站消息由长轮询产生）；
 * Node 宿主的完整长轮询收信在下一批补齐。
 */
export async function telegramSend(dataDir: string, chatId: string, text: string): Promise<{ ok: boolean }> {
  const creds = loadCredentials(dataDir);
  if (!creds) throw new Error("Telegram bot token 未配置");
  const response = await fetch(`${TG_API}/${creds.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Telegram sendMessage returned ${response.status}: ${body}`);
  }
  return { ok: true };
}

/** 发送输入状态提示（对方看到 "typing…"）。 */
export async function telegramSendTyping(dataDir: string, chatId: string): Promise<void> {
  const creds = loadCredentials(dataDir);
  if (!creds) throw new Error("Telegram bot token 未配置");
  await fetch(`${TG_API}/${creds.botToken}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Bot 链接：用户点开后在 Telegram 里给 bot 发 /start。 */
export function telegramBotLink(botToken: string): string {
  // bot id 是 token 的第一段（冒号分隔）。
  const botId = botToken.split(":")[0] ?? "";
  return botId !== "" ? `https://t.me/${botId}` : "";
}
