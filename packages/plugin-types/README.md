# @greywork/plugin-types

插件作者用的**纯类型包**（零运行时、无依赖）：让 workspace 里的插件代码能对宿主契约做类型检查，
也让第三方作者知道「worker 里到底能调什么」。

```ts
import type { GreyworkGlobal, PluginState, RenderFrame, PluginPackage } from "@greywork/plugin-types";

// worker 入口：宿主注入的全局对象，接口之外没有任何能力（无 DOM / 网络 / 定时器）
declare const greywork: GreyworkGlobal;

greywork.registerAction("refresh", async (state: PluginState) => {
  const res = await greywork.call("net.fetch", { url: "https://example.com/ping" });
  return { status: `HTTP ${res.status}`, at: Date.now() };
});

greywork.registerAction("draw", (): RenderFrame => [{ kind: "rect", x: 0, y: 0, w: 40, h: 40, fill: "#4d9fff" }]);
```

| 文件          | 内容                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `manifest.ts` | 包清单（作者写给宿主看的声明）与声明式页面 / 贡献面形状                                               |
| `worker.ts`   | `greywork` 全局（registerAction / registerSchedule / registerPointer / call / setStatus）与各能力签名 |
| `render.ts`   | 渲染指令集（SVG 白名单）与宿主边界常量                                                                |

## 边界

- 类型只是**提示**，真正的门禁在宿主：清单在安装期由
  `crates/greywork-host/src/services/plugin_market/package.rs` 校验，能力调用在运行期由前端
  broker + Rust 代理双重校验（声明之外的 host / 方法 / 路径一律拒绝）。
- 与宿主 `packages/workbench/src/plugins/market-types.ts` 的漂移由
  `packages/workbench/tests/types/plugin-manifest-parity.ts` 在 `pnpm typecheck` 时兜住：
  字段名不一致或标量类型变化会直接编译失败。
