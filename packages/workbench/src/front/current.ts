/**
 * 「当前是哪个前端」的唯一持有者。
 *
 * 形态与 `host-ipc/src/runtime.ts` 的运行时模式一致：模块级变量 + 显式 setter，入口在 mount
 * **之前**写入一次。为什么不走 `provide/inject`：读它的不止组件树内的东西（`lib/nav-items`
 * 是纯函数，「我是哪个前端」不该要求调用方先拿到一个组件实例），而且测试里要能直接换。
 *
 * 缺省值**刻意不存在**（2026-10-19 改）：`currentFront()` 在 Shell、nav-items、router 的
 * **运行期**被调用，只要它引用着全量集合，每个特性（连同其路由 chunk）对**每一个**前端都可达，
 * `apps/web` 自然也躲不掉。实测（有缺省时）：web 与 desktop 都是 259 个 chunk、JS 字节数
 * 相差不到 0.02%，`channels` 的 `dingtalk` 仍在 web 包里。
 *
 * 去掉缺省后，没被某端 import 的特性才真正从产物里消失。代价是「忘记声明」会立刻抛错，
 * 而不是静默拿到全量：
 * - 前端入口必须在 mount 前 `setFront(<该端的 FrontSpec>)`（apps/desktop / apps/web 各自声明）；
 * - 组件测试由 `tests/vitest.dom.setup.ts` 统一 `setFront(ALL_FEATURES_FRONT)`，
 *   单独挂载某个组件时行为与拆分前一致。
 *
 * 排除了两个「看起来很像」的原因（都做过对照实验）：不是 tree-shaking 被字符串注册表破坏
 * （`front/all.ts` / `front/web.ts` 都是逐个静态 import，没有 `FEATURES[id]` 查表），
 * 也不是 `package.json` 缺 `sideEffects`（补上只省约 2KB）。
 *
 * **`setFront` 只该由前端入口调用**，且必须在 mount 前 —— 导航项与路由都在那一刻定下。
 */
import { declareFront } from "@greywork/host-ipc";
import type { FrontSpec } from "./types";

let current: FrontSpec | null = null;

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
  if (!current) {
    throw new Error("当前前端未声明：入口必须在 mount 前调用 setFront(<FrontSpec>)");
  }
  return current;
}
