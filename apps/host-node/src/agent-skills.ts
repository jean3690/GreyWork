/**
 * 工作区技能（`.agents/skills/<id>/SKILL.md`）的本机 agent 接入。
 *
 * 只做「渐进披露」这一件事：系统提示里只放 id / 名称 / 一句话说明，正文由模型在需要时
 * 调 `read_skill` 读 —— 技能正文动辄几 KB，全塞进 system prompt 会挤掉真正的工作上下文。
 *
 * ACP agent 是自己在会话开始时扫技能目录的；本机回合没有那个机制，所以这份解析放在宿主。
 */
import path from "node:path";

import type { WorkspaceAccess } from "./workspace-access.js";

/** 与宿主安装校验一致：小写字母数字与连字符，≤64。 */
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillBrief {
  id: string;
  name: string;
  description: string;
}

export function skillRoot(cwd: string): string {
  return path.join(cwd, ".agents", "skills");
}

/** SKILL.md 的 frontmatter（只认 name / description，其余交给正文）。 */
export function parseFrontmatter(text: string): { name: string; description: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { name: "", description: "" };
  const meta = { name: "", description: "" };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (match[1] === "name") meta.name = value;
    else meta.description = value;
  }
  return meta;
}

/** 扫描工作区技能目录；目录不存在/无权读取都返回空数组（不是故障）。 */
export function listSkills(access: WorkspaceAccess, cwd: string): SkillBrief[] {
  let entries;
  try {
    entries = access.listDir(skillRoot(cwd));
  } catch {
    return [];
  }
  const out: SkillBrief[] = [];
  for (const entry of entries) {
    if (entry.kind !== "directory" || !SKILL_ID.test(entry.name)) continue;
    let text: string;
    try {
      text = access.readTextFile(path.join(entry.path, "SKILL.md"));
    } catch {
      continue;
    }
    const meta = parseFrontmatter(text);
    out.push({ id: entry.name, name: meta.name === "" ? entry.name : meta.name, description: meta.description });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 读一份技能的正文与同目录文件清单；id 非法/不存在都抛错（由工具层转成失败结果）。 */
export function readSkill(access: WorkspaceAccess, cwd: string, id: string): { text: string; files: string[] } {
  const trimmed = id.trim();
  if (!SKILL_ID.test(trimmed)) {
    throw new Error("技能 id 不合法（小写字母数字与连字符，≤64）: " + JSON.stringify(id));
  }
  const dir = path.join(skillRoot(cwd), trimmed);
  const text = access.readTextFile(path.join(dir, "SKILL.md"));
  const files = access
    .listDir(dir)
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.name)
    .sort();
  return { text, files };
}

/** 系统提示里的技能索引；没有技能时返回 null（不注入空段落）。 */
export function skillIndexPrompt(skills: SkillBrief[]): string | null {
  if (skills.length === 0) return null;
  const lines = [
    "本工作区安装了以下技能（SKILL.md 说明书）。需要时先调用 read_skill 读取完整内容，再按其中步骤执行；",
    "不要凭印象编造技能的做法，也不要假装读过没读过的技能。",
    "",
  ];
  for (const skill of skills) {
    const desc = skill.description === "" ? "（无描述）" : skill.description;
    lines.push("- " + skill.id + "（" + skill.name + "）：" + desc);
  }
  return lines.join("\n");
}
