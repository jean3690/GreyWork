import { DEFAULT_WORKSPACE_ID } from "../mocks/workspaces";
import type { Router } from "vue-router";

let routerRef: Router | null = null;

/** AppShell bootstrap 时注入，供非组件上下文（快捷键等）导航。 */
export function bindWorkbenchRouter(router: Router): void {
  routerRef = router;
}

/** 跳转到指定 mode（保持当前项目；未注册 mode 由路由守卫回退 chat）。 */
export async function ensureMode(mode: string): Promise<void> {
  if (!routerRef) return;
  const current = routerRef.currentRoute.value;
  const projectId = String(current.params.projectId ?? DEFAULT_WORKSPACE_ID);
  await routerRef.push(`/p/${projectId}/${mode}`);
}
