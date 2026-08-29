import { DEFAULT_WORKSPACE_ID } from "../mocks/workspaces";
import { capabilitySeam } from "../plugins/loader";
import WorkflowCanvas from "../components/WorkflowCanvas.vue";
import { createRouter, createWebHashHistory, type Router } from "vue-router";

/**
 * 可寻址外壳路由（hash 模式，Tauri 桌面端安全）。
 * mode 集合不写死：beforeEach 以 loader 激活快照校验；
 * 未注册 mode 一律回退到首个已注册 mode（缺省 chat，Cowork 即主舞台）；
 * 零注册能力时允许停留，由画布空态引导恢复（避免重定向循环）。
 */
export function createWorkbenchRouter(): Router {
  const router = createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: "/", redirect: `/p/${DEFAULT_WORKSPACE_ID}/chat` },
      { path: "/p/:projectId/:mode", component: WorkflowCanvas },
      { path: "/:pathMatch(.*)*", redirect: "/" },
    ],
  });

  router.beforeEach((to) => {
    const mode = to.params.mode as string | undefined;
    if (!mode) return true;
    const modes = capabilitySeam.snapshot().modes;
    if (modes.some((entry) => entry.id === mode)) return true;
    const fallback = modes[0]?.id;
    if (!fallback) return true;
    if (String(fallback) === String(mode)) return true;
    const projectId = String(to.params.projectId ?? DEFAULT_WORKSPACE_ID);
    return { path: `/p/${projectId}/${fallback}` };
  });

  return router;
}
