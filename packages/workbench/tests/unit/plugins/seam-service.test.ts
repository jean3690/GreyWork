// SeamService：Cordis Service + Vue ref 的贡献聚合器。
// 验证：注册即入快照；清理函数使贡献消失；经 loader 装载的插件在 fork 卸载时
// 由 ctx.effect 自动清理贡献——无需手动摘除。
import { Context } from "@cordisjs/core";
import { describe, expect, it } from "vitest";
import { defineComponent } from "vue";
import { createCapabilityLoader } from "@/plugins/loader";
import { SeamService } from "@/plugins/seam-service";

const Dummy = defineComponent({ render: () => null });

function createSeam(): Context {
  const ctx = new Context();
  ctx.plugin(SeamService);
  return ctx;
}

describe("seam service", () => {
  it("registers modes / uiRegions into the snapshot", () => {
    const ctx = createSeam();
    ctx.seam.registerMode({ id: "chat", title: "Chat", component: Dummy });
    ctx.seam.registerUiRegion({ region: "activityPanel", id: "activity.editor", title: "文件", component: Dummy });

    expect(ctx.seam.snapshot().modes.map((mode) => mode.id)).toEqual(["chat"]);
    expect(ctx.seam.snapshot().uiRegions.map((region) => region.id)).toEqual(["activity.editor"]);
  });

  it("removes contributions when the returned dispose runs", () => {
    const ctx = createSeam();
    const dispose = ctx.seam.registerMode({ id: "agents", title: "Agents", component: Dummy });
    expect(ctx.seam.snapshot().modes).toHaveLength(1);

    dispose();
    expect(ctx.seam.snapshot().modes).toHaveLength(0);
  });

  it("cleans up contributions when a loaded plugin is deactivated（ctx.effect 自动清理）", async () => {
    const loader = createCapabilityLoader();
    loader.register({
      id: "ext.tmp",
      name: "临时视图",
      version: "0.1.0",
      contributes: {
        modes: [{ id: "tmp", title: "Temp", component: Dummy }],
        capabilities: ["extension:ext.tmp"],
      },
    });
    await loader.activate("ext.tmp");
    expect(loader.snapshot().modes.map((mode) => mode.id)).toContain("tmp");

    await loader.deactivate("ext.tmp");
    expect(loader.snapshot().modes.map((mode) => mode.id)).not.toContain("tmp");
    expect(loader.snapshot().uiRegions).toHaveLength(0);
  });
});
