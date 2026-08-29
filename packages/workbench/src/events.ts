import { createEventBus } from "@greywork/core";

/**
 * 应用级事件契约：跨模块解耦通信（异步任务完成 / 状态变化通知）。
 * 生产者 emit，消费者 on/once 订阅；事件名与载荷在此静态声明，编译期校验。
 * 接入点（当前）：
 * - `run:status`：编排运行状态变化（agent store）
 * - `artifact:created`：交付物创建（chat mock 管线）
 */
export interface GreyWorkEventMap {
  /** 编排运行状态变化：status + 子任务完成进度。 */
  "run:status": {
    runId: string;
    status: "planning" | "running" | "done" | "failed";
    done: number;
    total: number;
  };
  /** 交付物创建完成（VFS 已落盘）；path 供产物查看器直接打开。 */
  "artifact:created": {
    name: string;
    path: string;
    format?: "md" | "csv" | "xlsx" | "pptx" | "html";
    source: string;
  };
  /** 请求预览面板加载指定文件（GenUI 产物跨面板联动）。 */
  "preview:request": { path: string };
  /** 请求编辑器面板打开指定文件（项目管理导入后联动右栏）。 */
  "editor:open": { path: string };
}

/** 全局事件总线：任何模块可通过此实例解耦通知（通知系统 / 状态栏等未来订阅方）。 */
export const appEvents = createEventBus<GreyWorkEventMap>();
