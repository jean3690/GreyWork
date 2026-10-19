/**
 * 「当前是哪个前端」的唯一持有者。
 *
 * 形态与 `host-ipc/src/runtime.ts` 的运行时模式一致：模块级变量 + 显式 setter，入口在 mount
 * **之前**写入一次。为什么不走 `provide/inject`：读它的不止组件树内的东西（`lib/nav-items`
 * 是纯函数，「我是哪个前端」不该要求调用方先拿到一个组件实例），而且测试里要能直接换。
 *
 * 缺省是 `ALL_FEATURES_FRONT`，于是：
 * - 现有 `createAppRouter()` / `buildNavItems(modes)` 的调用方（含 25 处测试）不带参也照旧；
 * - 某个组件被单独挂载（如 Sider 的单测）时拿到的是全量前端，与拆分前行为一致。
 *
 * ## 已知限制：这个缺省让「按端分叉」省不下包体积（2026-10-14 实测）
 *
 * `currentFront()` 被 `Shell.vue`、`lib/nav-items`、`router/index.ts` 在**运行期**调用，而它的
 * 缺省值是全量集合 —— 于是每个特性（连同其 `() => import(...)` 的路由 chunk）对**每一个**前端
 * 都可达，`apps/web` 自然也躲不掉。实测：web 与 desktop 两个产物都是 259 个 chunk、JS 字节数
 * 相差不到 0.02%，`channels` 的 `dingtalk` 仍在 web 包里；`ALL_FEATURES_FRONT` 的 label
 *（`桌面端（全特性）`）会出现在 web 的入口 chunk 里，可以直接 grep 它当反例。
 *
 * 排除了两个「看起来很像」的原因（都做了对照实验）：
 * - **不是** tree-shaking 被字符串注册表破坏：`front/all.ts` 与 `front/web.ts` 都是逐个静态
 *   import，没有 `FEATURES[id]` 查表。
 * - **不是** `package.json` 缺 `sideEffects`，也不是入口那个 dev-only 的
 *   `import("@greywork/workbench")` 动态导入：给 workbench 的 `sideEffects` 补上只匹配 CSS 的 glob（`**` 下的 `*.css`）
 *   只省下约 2KB；去掉那次动态导入，产物**一个字节都没变**。
 *
 * 真正的原因就是这一行的缺省本身：全量前端被一个运行期可达的模块级变量引用着，没有剪枝余地。
 * 要让 web 真的瘦下来，得去掉缺省（未声明即抛错），让入口与测试都显式传 front —— 那是**独立
 * 一轮**的改动（约 25 处调用点）。本阶段刻意不动：S4 的验收是「两端各自装载、web 不装托盘/
 * 关闭守卫与桌面专属导航」，那是**运行期**的差异，已经达成。
 *
 * **`setFront` 只该由前端入口调用**，且必须在 mount 前 —— 导航项与路由都在那一刻定下。
 */
import { declareFront } from "@greywork/host-ipc";
import { ALL_FEATURES_FRONT } from "./all";
import type { FrontSpec } from "./types";

let current: FrontSpec = ALL_FEATURES_FRONT;

/**
 * 设定当前前端。入口在 mount 前调用；测试可在用例里改，用完自己改回去。
 *
 * 顺带把身份落到 host-ipc（`declareFront`）：传输层与诊断只认 `FrontId`，拿不到
 * `FrontSpec`。「我是哪一端」与「我装哪些特性」是同一个事实，叫前端作者声明两遍、
 * 靠人记得同步，迟早对不上 —— 这里是那个唯一入口，两处状态由构造保证一致。
 */
export function setFront(front: FrontSpec): void {
  current = front;
  declareFront(front.id);
}

/**
 * 当前前端。**每次实时读、不缓存** —— 与 `runtimeMode()` 同一个理由：调用点大多是
 * 组件求值期或纯函数内的同步读取，缓存会让入口的设定（或测试的替换）失效。
 */
export function currentFront(): FrontSpec {
  return current;
}
