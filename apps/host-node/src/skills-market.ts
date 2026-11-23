export interface MarketSkillEntry {
  ref: string;
  skill_id: string;
  name: string;
  installs: number;
  source: string;
  downloadable: boolean;
  origin: string;
}

/** Java 的数组/snake_case 与第三方 skills.sh 的 {skills}/camelCase 统一为宿主契约。 */
export function normalizeSkillsSearch(raw: unknown, origin: string): MarketSkillEntry[] {
  const rows = Array.isArray(raw) ? raw : (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(rows)) throw new Error("invalid skills search response");
  return rows.flatMap((row: Record<string, unknown>) => {
    if (!row || typeof row !== "object") return [];
    const ref = row.ref ?? row.id;
    const skillId = row.skill_id ?? row.skillId;
    if (typeof ref !== "string" || typeof skillId !== "string" || !ref || !skillId) return [];
    return [
      {
        ref,
        skill_id: skillId,
        name: typeof row.name === "string" ? row.name : skillId,
        installs: typeof row.installs === "number" ? row.installs : 0,
        source: typeof row.source === "string" ? row.source : "",
        downloadable: row.downloadable !== false && ref.split("/").length === 3,
        origin,
      },
    ];
  });
}

export async function searchSkills(origin: string, query: string): Promise<MarketSkillEntry[]> {
  const suffix = `?q=${encodeURIComponent(query)}`;
  const official = new URL(origin).hostname.replace(/^www\./, "") === "skills.sh";
  const paths = official ? ["/api/search"] : ["/api/skills", "/api/search"];
  let response: Response | undefined;
  for (const pathname of paths) {
    response = await fetch(`${origin}${pathname}${suffix}`, { signal: AbortSignal.timeout(15_000) });
    if (response.status !== 404) break;
  }
  if (!response?.ok) throw new Error(`skills search returned ${response?.status}`);
  return normalizeSkillsSearch(await response.json(), origin);
}
