import type { PluginManifest, SkillDefinition, SkillManifest } from "./types";

export interface PluginRegistry {
  register(manifest: PluginManifest): void;
  unregister(id: string): boolean;
  get(id: string): PluginManifest | undefined;
  list(): PluginManifest[];
  skills(): SkillManifest[];
}

export interface SkillRegistry {
  registerSkill(skill: SkillDefinition): void;
  getSkill(id: string): SkillDefinition | undefined;
  listSkills(): SkillDefinition[];
}

export function createPluginRegistry(): PluginRegistry {
  const manifests = new Map<string, PluginManifest>();
  return {
    register(manifest) {
      manifests.set(manifest.id, manifest);
    },
    unregister(id) {
      return manifests.delete(id);
    },
    get(id) {
      return manifests.get(id);
    },
    list() {
      return Array.from(manifests.values());
    },
    skills() {
      return Array.from(manifests.values()).filter((m): m is SkillManifest => m.kind === "skill");
    },
  };
}

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, SkillDefinition>();
  return {
    registerSkill(skill) {
      skills.set(skill.id, skill);
    },
    getSkill(id) {
      return skills.get(id);
    },
    listSkills() {
      return Array.from(skills.values());
    },
  };
}
