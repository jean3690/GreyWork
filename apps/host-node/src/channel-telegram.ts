/**
 * Telegram 通道：Bot API（HTTPS + JSON），凭据落盘 0600 与发信。
 * 长轮询收信与入站事件在 channel-connectors.ts，连接态在 channel-runtime.ts。
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

/** 发消息：调 Telegram Bot API `sendMessage`。 */
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
