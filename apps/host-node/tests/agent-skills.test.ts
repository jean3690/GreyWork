/**
 * 工作区技能 → 本机 agent 的渐进披露：系统提示只放索引，正文靠 read_skill 取。
 *
 * 这里钉住三件事：frontmatter 解析（没有 frontmatter 也不能崩）、非法 id 被拒、
 * 以及「没有技能时不注入空段落」——空段落会让模型以为有东西没读到。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listSkills, parseFrontmatter, readSkill, skillIndexPrompt } from "../src/agent-skills.js";
import { executeTool } from "../src/llm-agent.js";
import { WorkspaceAccess } from "../src/workspace-access.js";

function workspaceWithSkills(): { root: string; access: WorkspaceAccess } {
  const root = mkdtempSync(path.join(tmpdir(), "gw-agent-skills-"));
  const skills = path.join(root, ".agents", "skills");
  mkdirSync(path.join(skills, "todo-scan", "references"), { recursive: true });
  writeFileSync(
    path.join(skills, "todo-scan", "SKILL.md"),
    "---\nname: TODO 扫描\ndescription: 汇总工作区的 TODO\n---\n\n# 步骤\n\n1. 搜索 TODO。\n",
  );
  writeFileSync(path.join(skills, "todo-scan", "references", "notes.md"), "# 备注\n");
  writeFileSync(path.join(skills, "todo-scan", "examples.md"), "# 示例\n");
  // 没有 SKILL.md 的目录、以及不合法的 id：都应被忽略。
  mkdirSync(path.join(skills, "empty-dir"), { recursive: true });
  mkdirSync(path.join(skills, "Bad Name"), { recursive: true });
  const access = new WorkspaceAccess(root, path.join(root, ".ledger.json"));
  access.authorizeSelectedPath(root);
  return { root, access };
}

describe("工作区技能", () => {
  it("frontmatter 解析：有则取 name/description，没有则返回空串", () => {
    expect(parseFrontmatter("---\nname: A\ndescription: B\n---\n正文")).toEqual({ name: "A", description: "B" });
    expect(parseFrontmatter("# 没有 frontmatter")).toEqual({ name: "", description: "" });
  });

  it("listSkills 只收有 SKILL.md 的合法目录", () => {
    const { root, access } = workspaceWithSkills();
    expect(listSkills(access, root)).toEqual([{ id: "todo-scan", name: "TODO 扫描", description: "汇总工作区的 TODO" }]);
  });

  it("没有技能目录时返回空数组且不注入系统提示", () => {
    const root = mkdtempSync(path.join(tmpdir(), "gw-agent-noskill-"));
    const access = new WorkspaceAccess(root, path.join(root, ".ledger.json"));
    access.authorizeSelectedPath(root);
    expect(listSkills(access, root)).toEqual([]);
    expect(skillIndexPrompt([])).toBeNull();
  });

  it("readSkill 返回正文与同目录文件；非法 id / 不存在都抛错", () => {
    const { root, access } = workspaceWithSkills();
    const skill = readSkill(access, root, "todo-scan");
    expect(skill.text).toContain("# 步骤");
    expect(skill.files).toEqual(["SKILL.md", "examples.md"]);
    expect(() => readSkill(access, root, "../etc")).toThrow(/不合法/);
    expect(() => readSkill(access, root, "nope")).toThrow();
  });

  it("系统提示索引包含 id 与一句话说明", () => {
    const { root, access } = workspaceWithSkills();
    const prompt = skillIndexPrompt(listSkills(access, root));
    expect(prompt).toContain("todo-scan");
    expect(prompt).toContain("TODO 扫描");
    expect(prompt).toContain("汇总工作区的 TODO");
    expect(prompt).toContain("read_skill");
  });

  it("read_skill 工具把正文交回模型", async () => {
    const { root, access } = workspaceWithSkills();
    const result = await executeTool(access, root, "read_skill", { skill_id: "todo-scan" });
    expect(result.error).toBeNull();
    expect(result.content).toContain("1. 搜索 TODO。");
    expect(result.content).toContain("examples.md");
    expect(result.summary).toBe("读取技能 todo-scan");
  });
});
