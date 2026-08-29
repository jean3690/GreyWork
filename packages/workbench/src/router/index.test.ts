// @vitest-environment happy-dom
// 路由守卫不跑在 resolve() 上，必须真实导航才能验到 fallback 分支；
// createWebHashHistory 又依赖 window，因此本文件单独启用 happy-dom
// （不改动 vitest 全局 environment，避免影响其余 99 个 node 环境用例）。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, defineComponent } from "vue";
import { createWorkbenchRouter } from "./index";
import { capabilitySeam } from "../plugins/loader";
import { coreBuiltinManifest } from "../plugins/registry";
import { DEFAULT_WORKSPACE_ID } from "../mocks/workspaces";

/** 建一个挂了 router 的最小 app：不 mount，只取守卫导航结果。 */
async function navigate(path: string): Promise<string> {
  const router = createWorkbenchRouter();
  const app = createApp(defineComponent({ render: () => null }));
  app.use(router);
  await router.push(path);
  await router.isReady();
  return router.currentRoute.value.path;
}

describe("workbench router", () => {
  beforeEach(async () => {
    if (!capabilitySeam.activeIds().includes("core.builtin")) {
      capabilitySeam.register(coreBuiltinManifest);
      await capabilitySeam.activate("core.builtin");
    }
  });

  it("根路径重定向到默认工作区的 chat", async () => {
    expect(await navigate("/")).toBe(`/p/${DEFAULT_WORKSPACE_ID}/chat`);
  });

  it("已注册 mode 原样放行", async () => {
    expect(await navigate("/p/p-city/agents")).toBe("/p/p-city/agents");
  });

  it("未注册 mode 回退首个 mode，且保留当前工作区", async () => {
    // 回归点：守卫 fallback 曾拼 projectId，重命名后必须仍是 URL 里的工作区
    expect(await navigate("/p/p-city/bogus-mode")).toBe("/p/p-city/chat");
    expect(await navigate("/p/p-general/bogus-mode")).toBe("/p/p-general/chat");
  });

  it("路由参数暴露 workspaceId 而非 projectId", async () => {
    const router = createWorkbenchRouter();
    const app = createApp(defineComponent({ render: () => null }));
    app.use(router);
    await router.push("/p/p-city/chat");
    await router.isReady();
    const params = router.currentRoute.value.params;
    expect(params.workspaceId).toBe("p-city");
    expect(params.projectId).toBeUndefined();
  });
});
