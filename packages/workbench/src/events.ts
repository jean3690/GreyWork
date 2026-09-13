import { createEventBus } from "@greywork/core";

/**
 * 应用级事件契约：跨模块解耦通信（异步任务完成 / 状态变化通知）。
 * 生产者 emit，消费者 on/once 订阅；事件名与载荷在此静态声明，编译期校验。
 * 接入点（当前）：
 * - `run:status`：编排运行状态变化（agent store）
 * - `artifact:created`：交付物创建（chat mock 管线）
 */
export interface GreyWorkEventMap {
  /** 编排/协作运行状态变化：status + 子任务完成进度。
   *  planning|running|done|failed 来自 planner 编排；paused|cancelled 来自 cowork 协作运行
   *  （预算触顶暂停、用户取消）。 */
  "run:status": {
    runId: string;
    status: "planning" | "running" | "paused" | "done" | "failed" | "cancelled";
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
  /** 已有交付物被就地修改（如给 Excel 追加一行）；查看器需重新加载该 tab。 */
  "artifact:updated": {
    name: string;
    path: string;
    format?: "md" | "csv" | "xlsx" | "pptx" | "html";
    source: string;
  };
  /** 请求预览面板加载指定文件（GenUI 产物跨面板联动）。 */
  "preview:request": { path: string };
  /** 请求编辑器面板打开指定文件（项目管理导入后联动右栏）。 */
  "editor:open": { path: string };
  /** 把一段现成文本（如网页正文）加进当前输入卡的附件草稿。 */
  "chat:attachText": { name: string; text: string; mime: string };
}

/** 全局事件总线：任何模块可通过此实例解耦通知（通知系统 / 状态栏等未来订阅方）。 */
export const appEvents = createEventBus<GreyWorkEventMap>();
