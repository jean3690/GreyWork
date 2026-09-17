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

// 每次 navigate 都建一个真 router（懒加载路由会拉起整个应用图），单例就要 4-5s；
// 默认 5s 超时在并行 + coverage 负载下会翻车，这里显式放宽。
describe("grey router", { timeout: 20_000 }, () => {
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

  it("设置已改为弹窗：/settings 不再是路由，按未匹配路径回落", async () => {
    expect(await navigate("/settings")).toBe("/guid");
    expect(await navigate("/settings/appearance")).toBe("/guid");
  });

  it("未匹配路径回落到 /guid", async () => {
    expect(await navigate("/definitely/not/a/route")).toBe("/guid");
  });
});
