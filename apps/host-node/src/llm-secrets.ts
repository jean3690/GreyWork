/**
 * 供应商密钥（第三方模型直接填 key，不必再 export 环境变量 + 重启）。
 *
 * 落盘位置：`<dataDir>/llm-secrets.json`（0600），键是**归一化后的 baseUrl**。
 * 为什么按 baseUrl：所有 LLM 调用本来就带着它，宿主侧不需要为「哪个 providerId」
 * 再加一条参数链；同一 baseUrl 视作同一个供应商的凭据（同一网关换 key 的场景很少见）。
 *
 * 边界：密钥只在宿主进程里读，任何命令都只回显掩码；渲染端与设置快照里永远没有明文。
 * 优先级：手填的 key > 环境变量（apiKeyEnv）。两者都没有时沿用原来的报错提示。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface StoredSecret {
  apiKey: string;
  updatedAt: number;
}

const FILE = "llm-secrets.json";
let dataDir: string | null = null;
let cache: Record<string, StoredSecret> | null = null;

export function configureSecretStore(dir: string): void {
  dataDir = dir;
  cache = null;
}

function file(): string {
  if (dataDir === null) throw new Error("密钥存储未初始化");
  return path.join(dataDir, FILE);
}

/** baseUrl 归一化：去空白与结尾斜杠（大小写不动 —— 路径可能区分大小写）。 */
export function normalizeBaseUrlKey(baseUrl: string | null | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

function load(): Record<string, StoredSecret> {
  if (cache !== null) return cache;
  cache = {};
  if (dataDir === null) return cache;
  try {
    if (!existsSync(file())) return cache;
    const parsed = JSON.parse(readFileSync(file(), "utf8")) as Record<string, StoredSecret>;
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value.apiKey === "string" && value.apiKey !== "") {
        cache[key] = { apiKey: value.apiKey, updatedAt: Number(value.updatedAt) || 0 };
      }
    }
  } catch {
    // 文件坏掉就当没有：不能让一个坏 JSON 拦住所有模型调用。
    cache = {};
  }
  return cache;
}

function persist(next: Record<string, StoredSecret>): void {
  if (dataDir === null) throw new Error("密钥存储未初始化");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify(next), { mode: 0o600 });
  cache = next;
}

/** 掩码：够用户确认「是不是这把」，不够拼回原文。 */
export function maskSecret(apiKey: string): string {
  const value = apiKey.trim();
  if (value === "") return "";
  if (value.length <= 10) return "****";
  return value.slice(0, 6) + "…" + value.slice(-4);
}

/** 写一把 key（覆盖）。返回掩码。 */
export function setSecret(baseUrl: string, apiKey: string): { masked: string } {
  const key = normalizeBaseUrlKey(baseUrl);
  if (key === "") throw new Error("缺少 baseUrl：密钥按 baseUrl 归属，先填提供商地址");
  const value = apiKey.trim();
  if (value === "") throw new Error("apiKey 不能为空");
  const next = { ...load(), [key]: { apiKey: value, updatedAt: Date.now() } };
  persist(next);
  return { masked: maskSecret(value) };
}

/**
 * 把密钥从旧 baseUrl 迁到新 baseUrl（用户改了供应商地址时用）。
 * 目标已有密钥时以源为准覆盖 —— 改了地址说明还是同一个供应商。
 */
export function moveSecret(fromBaseUrl: string, toBaseUrl: string): { moved: boolean } {
  const from = normalizeBaseUrlKey(fromBaseUrl);
  const to = normalizeBaseUrlKey(toBaseUrl);
  if (from === "" || to === "" || from === to) return { moved: false };
  const current = load();
  const source = current[from];
  if (!source) return { moved: false };
  const next = { ...current };
  delete next[from];
  next[to] = { apiKey: source.apiKey, updatedAt: Date.now() };
  persist(next);
  return { moved: true };
}

export function clearSecret(baseUrl: string): boolean {
  const key = normalizeBaseUrlKey(baseUrl);
  const current = load();
  if (!(key in current)) return false;
  const next = { ...current };
  delete next[key];
  persist(next);
  return true;
}

/** 某个 baseUrl 是否已存 key（只回掩码）。 */
export function secretStatus(baseUrl: string): { saved: boolean; masked: string | null } {
  const key = normalizeBaseUrlKey(baseUrl);
  const hit = load()[key];
  return hit ? { saved: true, masked: maskSecret(hit.apiKey) } : { saved: false, masked: null };
}

/** 全部已存密钥（掩码），供设置页给供应商打「已存密钥」标记。 */
export function listSecrets(): { baseUrl: string; masked: string; updatedAt: number }[] {
  return Object.entries(load()).map(([baseUrl, value]) => ({
    baseUrl,
    masked: maskSecret(value.apiKey),
    updatedAt: value.updatedAt,
  }));
}

/** 解析用：有手填 key 就返回它，否则 null（调用方回落到环境变量）。 */
export function secretFor(baseUrl: string | null | undefined): string | null {
  const key = normalizeBaseUrlKey(baseUrl);
  if (key === "") return null;
  return load()[key]?.apiKey ?? null;
}
