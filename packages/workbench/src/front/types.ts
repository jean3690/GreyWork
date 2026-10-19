/**
 * 「一个后端、多个前端」的前端契约。
 *
 * 分工只有一条准则，别在这里发明第三种：
 *
 * > **能整块删掉的差异 → 写进本文件的静态声明；必须按宿主灰显并说明原因的 → 留在 `/api/commands` 的 `available`。**
 *
 * 举例对齐：Web 端根本没有托盘，那就**不装**托盘桥（本文件）；而「导出为 PDF」在 Web 上
 * 服务端就是不做，用户仍该看见按钮、灰着并读到一句为什么（`/api/commands`）。
 *
 * 声明必须是**编译期常量**，不能是运行期查表 —— 见 `front/all.ts` 顶部关于 tree-shaking 的说明。
 */
import type { RouteRecordRaw } from "vue-router";
import type { FrontId } from "@greywork/host-ipc";

/**
 * 前端身份的**原定义在 `@greywork/host-ipc`**（见其 `src/front.ts` 的 `declareFront`）：
 * 运行时也要用它（诊断、S5 的不经 workbench 的第三方前端），而依赖方向是
 * workbench → host-ipc，反过来在这里定义一份、那边再抄一份，迟早对不上。
 * 这里只做转口，让组装代码从「前端契约」一处就能取全。
 */
export type { FrontId };

/** 侧栏快捷入口一项。Sider 与标题栏搜索共用同一份，避免「侧栏有入口、搜索搜不到」。 */
export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

/** 可被前端取舍的功能块。id 取 `features/<id>/` 的目录名。 */
export type FeatureId = "guid" | "conversation" | "assistants" | "channels" | "automation" | "team" | "plugins";

export interface Feature {
  id: FeatureId;
  /**
   * 本特性贡献的路由。**视图继续用 `() => import(...)` 懒加载** ——
   * 直接 import 组件会让 ConversationView 那条链把 ExcelJS / pptxgenjs / jszip
   * 焊进入口 chunk，从不产表格的用户开屏就要解析几百 KB 写入器。
   */
  routes?: readonly RouteRecordRaw[];
  /** 贡献给侧栏与搜索的入口。顺序即展示顺序（同一前端内）。 */
  nav?: readonly NavItem[];
  /**
   * 应用级接线，**仅在本特性被该前端启用时**才跑。
   *
   * 与 `FrontShellSpec.wiring` 的分界：这里是**特性自己的**依赖启动（少了它这个特性就是坏的），
   * 那里是**宿主外壳**的接线（少了它特性照常工作，只是没有那层宿主集成）。
   * 有了这个字段，「前端没启用 channels」就自动等于「不注册六条通道的监听」，
   * 不必再指望前端作者记得同步两处清单。
   */
  setup?: () => void | Promise<void>;
}

/**
 * 宿主外壳级接线。每一条都是「这个宿主有没有这层集成」，与具体特性无关。
 *
 * - `queueBridge`：命令队列补发要经 dispatchIntent 分流。**必须在 setup 期就位**，
 *   因为补发由 store 内触发，晚一步就会走错分支（见 `lib/queue-bridge.ts`）。
 * - `plugins` 不在这里：插件启动是 `plugins` 特性自己的事，见 `Feature.setup`。
 */
export type ShellWiringId = "queueBridge" | "tray" | "closeGuard" | "hostNotifications";

/** 外壳渲染哪几块面板。同时也是 `syncViewport()` 视口判断的**上界**，见 `features/shell/Shell.vue`。 */
export interface ShellPanels {
  sider: boolean;
  preview: boolean;
  workspace: boolean;
  activity: boolean;
  terminal: boolean;
}

export interface FrontShellSpec {
  panels: ShellPanels;
  wiring: readonly ShellWiringId[];
}

/** 一个前端 = 特性集 + 外壳形态。入口在 mount 前把选定的这一份交给 workbench。 */
export interface FrontSpec {
  id: FrontId;
  /** 人读的名字，用于日志与调试面板，不参与 UI 文案（UI 文案走 i18n）。 */
  label: string;
  features: readonly Feature[];
  shell: FrontShellSpec;
}
