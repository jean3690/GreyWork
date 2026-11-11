/**
 * Worker prelude：插件代码在 Web Worker 里能看到的**全部**宿主接口。
 *
 * worker 无 DOM、无定时器、无网络、无文件访问；一切副作用都经 `greywork.call` 由宿主代执行
 * （鉴权、限域、审计都在宿主侧）。把这里当沙箱的边界看：接口之外的能力，插件代码碰不到。
 */
import type { DeclarativeValue } from "./manifest";

/** 声明式状态：字段值只有 string / number / boolean，结构简单才好在宿主侧校验与持久化。 */
export type PluginState = Readonly<Record<string, DeclarativeValue>>;

/** 动作返回值：并入区域/页面状态的补丁（只允许标量，见 PluginState）。 */
export type PluginPatch = Record<string, DeclarativeValue>;

/** 动作处理器：state → patch。抛错会冒泡成 `action failed`，状态保持不变。 */
export type ActionHandler = (state: PluginState) => PluginPatch | void | Promise<PluginPatch | void>;

/** 定时处理器：由宿主按 manifest 声明的间隔唤醒，语义与动作相同。 */
export type ScheduleHandler = ActionHandler;

/** 指针事件类型：宿主构造、封闭枚举，worker 不需要自证。 */
export type PointerEventType = "down" | "move" | "up" | "cancel" | "leave";

/**
 * 归一化指针事件：坐标已由宿主换算到画布坐标系并裁剪进画布，
 * `nx/ny` 是 [0,1] 归一化值；`buttons` 是原始按键位。
 */
export interface PluginPointerEvent {
  type: PointerEventType;
  x: number;
  y: number;
  nx: number;
  ny: number;
  buttons: number;
  pointerId: number;
}

/** 指针处理器：返回状态补丁，与动作同一条合并通道。 */
export type PointerHandler = (event: PluginPointerEvent, state: PluginState) => PluginPatch | void | Promise<PluginPatch | void>;

/** 能力 id → 参数 / 结果（见 capabilities.ts）。 */
export interface CapabilityMap {
  "storage.kv": {
    args:
      | { op: "get"; key: string }
      | { op: "set"; key: string; value: unknown }
      | { op: "remove"; key: string }
      | { op: "list" }
      | { op: "clear" };
    result: { value?: unknown; keys?: string[]; ok?: boolean };
  };
  "net.fetch": {
    args: {
      url: string;
      method?: "GET" | "HEAD" | "POST";
      headers?: Record<string, string>;
      body?: string;
    };
    result: { status: number; ok: boolean; headers: Record<string, string>; body: string };
  };
  "llm.chat": {
    args: { prompt: string; system?: string; model?: string };
    result: { text: string; model: string };
  };
  clipboard: {
    args: { op: "write"; text: string } | { op: "read" };
    result: { written?: boolean; text?: string; truncated?: boolean };
  };
  notify: {
    args: { title: string; body: string };
    result: { sent: boolean; title?: string; body?: string };
  };
  "artifacts.publish": {
    args: { name: string; format: "md" | "html" | "csv"; data: string };
    result: { id: string; name: string; path: string; format: string };
  };
  "fs.scoped": {
    args:
      | { op: "read"; path: string }
      | { op: "write"; path: string; data: string }
      | { op: "remove"; path: string }
      | { op: "list"; path?: string }
      | { op: "stat"; path: string };
    result: {
      exists?: boolean;
      data?: string | null;
      bytes?: number;
      totalBytes?: number;
      removed?: boolean;
      entries?: string[];
    };
  };
  "workspace.read": {
    args: { path?: string };
    result: { roots?: string[]; exists?: boolean; path?: string; name?: string; data?: string };
  };
  "mcp.connect": {
    args: { server: string; tool: string; args?: Record<string, unknown> };
    result: { transport?: string; isError?: boolean; text?: string };
  };
}

export type CapabilityId = keyof CapabilityMap;

/**
 * worker 全局 `greywork`：唯一宿主接口。
 *
 * 注意 `schedule` 是宿主驱动能力（宿主按声明间隔调用 registerSchedule 的处理器），
 * 不是可调用能力——`call("schedule", …)` 会被拒绝。
 */
export interface GreyworkGlobal {
  /** 注册动作处理器；name 需匹配 `[a-z0-9][a-z0-9._:-]{0,95}`，且不能叫 schedule/pointer。 */
  registerAction(name: string, handler: ActionHandler): void;
  /** 注册定时处理器：需 manifest 声明 schedule 能力。 */
  registerSchedule(handler: ScheduleHandler): void;
  /** 注册指针处理器：需 manifest 声明 runtime.render.pointer = true。 */
  registerPointer(handler: PointerHandler): void;
  /** 调用宿主能力；未在 manifest requires 里声明的能力会被宿主拒绝。 */
  call<C extends CapabilityId>(capability: C, args: CapabilityMap[C]["args"]): Promise<CapabilityMap[C]["result"]>;
  /** 更新状态栏条目文案（id 必须是 manifest 声明过的 statusBar 条目）。 */
  setStatus(id: string, text: string): void;
}

declare global {
  var greywork: GreyworkGlobal;
}
