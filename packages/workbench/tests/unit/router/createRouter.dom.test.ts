// 路由测试与既有 router/index.test.ts 同理：hash history 依赖 window，单独开 happy-dom。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, defineComponent } from "vue";
import { createAppRouter } from "@/router";

async function navigate(path: string): Promise<string> {
  const router = createAppRouter();
  const app = createApp(defineComponent({ render: () => null }));
  app.use(router);
  await router.push(path);
  await router.isReady();
  return router.currentRoute.value.path;
}

describe("grey router", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));

  it("根路径重定向到 /guid", async () => {
    expect(await navigate("/")).toBe("/guid");
  });

  it("已注册页面原样放行", async () => {
    expect(await navigate("/guid")).toBe("/guid");
    expect(await navigate("/assistants")).toBe("/assistants");
    expect(await navigate("/scheduled")).toBe("/scheduled");
    expect(await navigate("/team")).toBe("/team");
  });

  it("settings 缺省段回落到 agent", async () => {
    expect(await navigate("/settings")).toBe("/settings/agent");
  });

  it("settings 子页放行并暴露 section 参数", async () => {
    const router = createAppRouter();
    const app = createApp(defineComponent({ render: () => null }));
    app.use(router);
    await router.push("/settings/appearance");
    await router.isReady();
    expect(router.currentRoute.value.path).toBe("/settings/appearance");
    expect(router.currentRoute.value.params.section).toBe("appearance");
  });

  it("未匹配路径回落到 /guid", async () => {
    expect(await navigate("/definitely/not/a/route")).toBe("/guid");
  });
});
