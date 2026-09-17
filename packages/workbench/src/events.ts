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
    /** 落盘后的磁盘路径（未落盘/浏览器态省略）；预览据此提供「用系统应用打开」。 */
    diskPath?: string;
  };
  /** 已有交付物被就地修改（如给 Excel 追加一行）；查看器需重新加载该 tab。 */
  "artifact:updated": {
    name: string;
    path: string;
    format?: "md" | "csv" | "xlsx" | "pptx" | "html";
    source: string;
    diskPath?: string;
  };
  /** 请求预览面板加载指定文件（跨面板联动：agent 回合产物、会话附件等）。
   *  source 缺省按 vfs 处理；磁盘文件务必带 source: "disk"，否则会开错读取通道。 */
  "preview:request": { path: string; name?: string; source?: "vfs" | "disk"; diskPath?: string };
  /** 请求编辑器面板打开指定文件（项目管理导入后联动右栏）。
   *  当前无编辑器面板，由 preview-bridge 降级为预览打开；编辑器面板落地后移除降级。 */
  "editor:open": { path: string };
  /** 把一段现成文本（如网页正文）加进当前输入卡的附件草稿。 */
  "chat:attachText": { name: string; text: string; mime: string };
  /** 预填输入框草稿并聚焦（预览划词 → 问 AI / 解释 / 改写）。
   *  append 时空行分隔追加，且草稿为空时等同 replace —— 不覆盖用户已写的内容。 */
  "chat:prefill": { text: string; mode?: "replace" | "append" };
  /** 请求打开设置弹窗（可指定分区）；远程助手页等「去设置配置」入口使用。 */
  "settings:open": { section?: string };
}

/** 全局事件总线：任何模块可通过此实例解耦通知（通知系统 / 状态栏等未来订阅方）。 */
export const appEvents = createEventBus<GreyWorkEventMap>();
