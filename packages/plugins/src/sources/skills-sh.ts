import type { MarketSkillEntry, SkillSnapshot, SkillSourceAdapter, SkillsMarketTransport } from "./types";

export const SKILLS_SH_DEFAULT_ORIGIN = "https://www.skills.sh";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 非空字符串字段；空串视为缺失。 */
function strAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : 0;
}

/** 归一化 skills.sh 搜索响应；缺 skillId 的脏数据丢弃。
 * scopeSource 给定时只保留该仓库源（如 "larksuite/cli"）。
 * origin 给定时写入条目，供下载路由到对应源。 */
export function mapSearchResponse(raw: unknown, options?: { scopeSource?: string; origin?: string }): MarketSkillEntry[] {
  if (!isRecord(raw) || !Array.isArray(raw.skills)) return [];
  const out: MarketSkillEntry[] = [];
  for (const item of raw.skills) {
    if (!isRecord(item)) continue;
    const ref = strAt(item, "id");
    const skillId = strAt(item, "skillId");
    if (!ref || !skillId) continue;
    const source = strAt(item, "source") ?? "";
    if (options?.scopeSource && source !== options.scopeSource) continue;
    out.push({
      ref,
      skillId,
      name: strAt(item, "name") ?? skillId,
      installs: numAt(item, "installs"),
      source,
      downloadable: ref.split("/").length === 3,
      origin: options?.origin,
    });
  }
  return out;
}

/** 校验下载快照结构（防御性：宿主已校验，这里保证前端拿到的形状可信）。 */
export function parseSnapshot(raw: unknown): SkillSnapshot {
  if (!isRecord(raw) || !Array.isArray(raw.files)) throw new Error("invalid snapshot payload");
  const files: { path: string; contents: string }[] = [];
  for (const entry of raw.files) {
    if (!isRecord(entry)) continue;
    const path = strAt(entry, "path");
    if (!path || typeof entry.contents !== "string") continue;
    files.push({ path, contents: entry.contents });
  }
  return { files, hash: typeof raw.hash === "string" ? raw.hash : "" };
}

/** 基于 skills.sh 协议（search/download 同源）的源。
 * origin 给定时走自定义端点而非默认 skills.sh；scopeSource 用于派生子源（如飞书 larksuite/cli）。 */
export function createSkillsShSource(
  transport: SkillsMarketTransport,
  options: { id: string; label: string; description: string; scopeSource?: string; origin?: string },
): SkillSourceAdapter {
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    async search(query: string): Promise<MarketSkillEntry[]> {
      const raw = await transport.search(query, options.origin);
      return mapSearchResponse(raw, { scopeSource: options.scopeSource, origin: options.origin });
    },
    async download(entry: MarketSkillEntry): Promise<SkillSnapshot> {
      if (!entry.downloadable) throw new Error(`site source is not downloadable: ${entry.ref}`);
      return parseSnapshot(await transport.download(entry.ref, entry.origin ?? options.origin));
    },
  };
}

/** 内置源注册表：全量聚合 + 飞书 Lark 官方技能（larksuite/cli 仓库，中英双语）。 */
export function createBuiltinSources(transport: SkillsMarketTransport): SkillSourceAdapter[] {
  return [
    createSkillsShSource(transport, {
      id: "skills-sh",
      label: "Skills Directory",
      description: "skills.sh 全量聚合索引（GitHub 仓库源）",
    }),
    createSkillsShSource(transport, {
      id: "feishu-lark",
      label: "飞书 Lark",
      description: "飞书官方办公技能 · larksuite/cli · 中英双语",
      scopeSource: "larksuite/cli",
    }),
  ];
}
