import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Project, ThreadGroup, ThreadItem } from "../types";
import { MOCK_PROJECTS } from "../mocks/projects";
import { MOCK_THREAD_GROUPS } from "../mocks/threads";

let threadSeq = 0;

/** Projects 顶层组织：项目 / 线程。 */
export const useProjectStore = defineStore("project", () => {
  const projects = ref<Project[]>(MOCK_PROJECTS);
  const activeProjectId = ref<string | null>(MOCK_PROJECTS[0]?.id ?? null);
  const threadGroups = ref<ThreadGroup[]>(structuredClone(MOCK_THREAD_GROUPS));

  function projectByName(name: string): Project | undefined {
    return projects.value.find((project) => project.name === name || project.id === name);
  }

  function setActiveProject(id: string): void {
    activeProjectId.value = id;
  }

  /** 新建线程（归属指定项目名或「普通对话」），返回新线程 id。 */
  function startNewThread(projectName: string | null): string {
    const group0 = projectName ?? "普通对话";
    let group = threadGroups.value.find((candidate) => candidate.project === group0);
    if (!group) {
      group = { project: group0, threads: [] };
      threadGroups.value.unshift(group);
    }
    if (!group.projectId) {
      const match = projectByName(group0);
      if (match) group.projectId = match.id;
    }
    threadSeq += 1;
    const thread: ThreadItem = { id: `th-new-${threadSeq}`, title: "新对话", time: "刚刚" };
    group.threads.unshift(thread);
    return thread.id;
  }

  return {
    projects,
    activeProjectId,
    threadGroups,
    projectByName,
    setActiveProject,
    startNewThread,
  };
});

/** 当前激活线程的所属项目（跨 store 派生，供 TopBar 面包屑使用）。 */
export function useActiveProjectResolver() {
  const projectStore = useProjectStore();
  return computed(() => projectStore.projects.find((project) => project.id === projectStore.activeProjectId) ?? null);
}
