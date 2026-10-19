/**
 * 「全特性」前端：桌面端实际用的那一份。
 *
 * ## 为什么特性集必须静态 import，不能按 id 查表
 *
 * 这里**逐个静态 import** 每个 feature，而不是维护 `FEATURES: Record<FeatureId, Feature>`
 * 再让前端写 `["guid","conversation"].map(id => FEATURES[id])`。后者看着更「数据驱动」，
 * 但 Rollup 无法证明 `FEATURES[...]` 的结果被用到 —— 整张表连同它 import 的所有视图
 * 都会被保留，`apps/web` 就永远瘦不下来（这正是本阶段最容易踩空的地方）。
 * 静态 import + 字面量数组能让剪枝照常发生：没被任何前端 import 的 feature 直接消失。
 * 特性内部的视图仍然用 `() => import(...)`，路由级代码分割不受影响。
 *
 * ## 它不再是谁的缺省值
 *
 * 这份集合只被两处 import：`apps/desktop` 的入口（显式 `setFront`）与组件测试的 setup
 * （`tests/vitest.dom.setup.ts`，让单组件挂载有全量路由可用）。`front/current.ts` 里**没有**
 * 指向它的缺省 —— 否则 web 入口会经由运行期可达的 `currentFront()` 把全部特性拖进产物。
 * 它通过 `@greywork/workbench/front/all` 子路径导入，不进 barrel。
 */
import type { FrontSpec } from "./types";
import { guidFeature } from "@/features/guid/spec";
import { conversationFeature } from "@/features/conversation/spec";
import { assistantsFeature } from "@/features/assistants/spec";
import { channelsFeature } from "@/features/channels/spec";
import { automationFeature } from "@/features/automation/spec";
import { teamFeature } from "@/features/team/spec";
import { pluginsFeature } from "@/features/plugins/spec";

export const ALL_FEATURES_FRONT: FrontSpec = {
  id: "desktop",
  label: "桌面端（全特性）",
  // 顺序 = 路由注册顺序，因此它同时决定「同一路径多匹配时谁赢」。
  // 逐项与拆分前 router/index.ts 的数组顺序一致，改动这里等于悄悄改路由优先级。
  features: [guidFeature, conversationFeature, assistantsFeature, channelsFeature, automationFeature, teamFeature, pluginsFeature],
  shell: {
    panels: { sider: true, preview: true, workspace: true, activity: true, terminal: true },
    // 托盘与关窗守卫是**桌面壳独有**的宿主集成：纯服务端自托管与 Web 预览里既没有托盘，
    // 也没有「点 X 关窗」这个动作。把它们列在这里，正是 S4 拆 Web 端时最实的一处收益。
    wiring: ["queueBridge", "tray", "closeGuard", "hostNotifications"],
  },
};
