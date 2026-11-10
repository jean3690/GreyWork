/**
 * 通道凭据管理：七件套共用同一套落盘/加载/清除逻辑。
 *
 * 每个通道的凭据形状不同（bot token / client_id+secret / app_id+app_secret / bot_id+secret），
 * 但都落在 `<dataDir>/<channel>/credentials.json`（0600），都通过 `save/load/clear` 三个操作管理。
 * 连接状态机与生命周期在 channel-runtime.ts，不在这里。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const CHANNELS = ["dingtalk", "discord", "feishu", "qq", "telegram", "wechat", "wecom"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export function isChannelName(name: string): name is ChannelName {
  return (CHANNELS as readonly string[]).includes(name);
}

function channelDir(dataDir: string, channel: ChannelName): string {
  return path.join(dataDir, channel);
}

function credentialsFile(dataDir: string, channel: ChannelName): string {
  return path.join(channelDir(dataDir, channel), "credentials.json");
}

export function saveChannelCredentials(dataDir: string, channel: ChannelName, credentials: Record<string, unknown>): void {
  mkdirSync(channelDir(dataDir, channel), { recursive: true });
  writeFileSync(credentialsFile(dataDir, channel), JSON.stringify(credentials), { mode: 0o600 });
}

export function loadChannelCredentials(dataDir: string, channel: ChannelName): Record<string, unknown> | null {
  const file = credentialsFile(dataDir, channel);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function clearChannelCredentials(dataDir: string, channel: ChannelName): void {
  rmSync(credentialsFile(dataDir, channel), { force: true });
}
