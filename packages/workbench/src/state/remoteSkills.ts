/**
 * 远程技能安装记录（localStorage 持久化）。文件实体落在工作区
 * `.agents/skills/<skillId>/`，此处只保存展示与卸载所需的元数据。
 */

export interface RemoteSkillRecord {
  sourceId: string;
  ref: string;
  skillId: string;
  name: string;
  installs: number;
  hash: string;
  /** 安装时快照的文件路径清单（确认弹层/详情展示） */
  files: string[];
  installedAt: number;
}

const STORAGE_KEY = "greywork.remote-skills";

function isRemoteSkillRecord(value: unknown): value is RemoteSkillRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sourceId === "string" &&
    typeof record.ref === "string" &&
    typeof record.skillId === "string" &&
    Array.isArray(record.files)
  );
}

export function loadRemoteSkills(): RemoteSkillRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRemoteSkillRecord);
  } catch {
    return [];
  }
}

export function saveRemoteSkills(records: RemoteSkillRecord[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}
