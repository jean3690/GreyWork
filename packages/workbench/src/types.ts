/** workbench 共享领域类型（mock 阶段形状，后续接真实包时在此演进）。 */

/** 工作区：会话归属的顶层组织单位（可绑定用户选择的存放文件夹）。 */
export interface Workspace {
  id: string;
  name: string;
  description: string;
}

export type ChatStepKind = "read" | "exec" | "test" | "search" | "write";

export interface ChatStep {
  kind: ChatStepKind;
  label: string;
  detail: string;
  status: "wait" | "running" | "done";
}

/** Agent 工具调用类型（对齐 ACP tool_call kind 子集）。 */
export type ToolActivityKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

/** 单次工具调用的生命周期。 */
export type ToolActivityStatus = "pending" | "in_progress" | "completed" | "failed" | "interrupted";

/**
 * 工具调用的可展开细节：ACP `tool_call` 的 content / rawInput / rawOutput 归一化后的展示载荷。
 * 没有它的话，时间线只能显示「调了 write」而看不见到底写了什么。
 */
export interface ToolDetail {
  /** 文件差异（diff 内容块）；write 是 oldText 为 null 的整文件写入。 */
  diff?: { path: string; oldText: string | null; newText: string };
  /** 文本正文：读取结果、命令输出、MCP 工具返回。 */
  text?: string;
  /** 入参预览（JSON pretty）。MCP 工具只有工具名，全靠入参说明干了什么。 */
  args?: string;
  /** 终端 id：输出经终端通道另行推送，此处只标记归属。 */
  terminalId?: string;
  /** 源内容超出留存上限被截断（会话要落盘，不能把整个大文件塞进存档）。 */
  clipped?: boolean;
}

/**
 * AskUserQuestion（agent 向用户提问）的选择菜单载荷。
 *
 * 数据源是 ACP 工具调用里名为 `AskUserQuestion` 的那一次调用：`rawInput.questions`
 * 带题干与选项。宿主没有 client→agent 的工具结果通道，所以用户的选择以一条普通
 * 用户消息回传同一会话（见 AskQuestionCard）。
 */
export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** 短标题（工具语义里的 header），渲染成选项组上方的小标签。 */
  header?: string;
  options: AskOption[];
  /** 多选：渲染复选框 + 确认；单选即点即提交。 */
  multiSelect?: boolean;
}

/** 单题的作答：选中的选项 label，外加可选的自由文本补充。 */
export interface AskAnswer {
  question: string;
  labels: string[];
  custom?: string;
}

export interface AskRequest {
  questions: AskQuestion[];
  /** 已作答题目的答案；非空即表示卡片已收口为只读态。 */
  answers?: AskAnswer[];
  answeredAt?: number;
}

/**
 * 一条 Agent 工具活动记录（前端「工具聚合时间线」的最小数据单元）。
 * 由 ACP agent_message 的 tool_call / tool_call_result 内容解析而来，
 * 也可由 mock 管线直接构造。
 */
export interface ToolActivity {
  /** 工具调用 id（同一次调用去重 / 生命周期续写锚点）。 */
  toolCallId: string;
  kind: ToolActivityKind;
  status: ToolActivityStatus;
  /** 触发时间（ms）。 */
  startedAt: number;
  /** 完成时间（ms）；null = 尚未 settle。 */
  finishedAt: number | null;
  /** 命令（execute / bash）或操作名。 */
  command?: string;
  /** 涉及的文件路径（绝对或相对展示路径）。 */
  path?: string;
  /** 人类可读的动作描述。 */
  description?: string;
  /** 工具名（MCP 工具为剥掉 `mcp__<server>__` 前缀后的名字）。 */
  name?: string;
  /** MCP 服务器名；非空表示这次调用打到外部 MCP 服务器（客户端内建桥 `acp` 不算）。 */
  mcpServer?: string;
  /** 失败原因摘要（failed 时）。 */
  error?: string;
  /** 可展开细节（写入内容 / 输出 / 入参）。 */
  detail?: ToolDetail;
  /** 提问载荷：这次调用是 AskUserQuestion 时非空（消息侧渲染选择菜单）。 */
  ask?: AskRequest;
}

/**
 * 助手消息的一个有序段落。
 *
 * - `thinking`：一段连续的推理流。被正文/工具打断后，下一波思考另起一段 ——
 *   所以一条消息可以有多个「已思考 Ns」折叠条，而不是把整轮推理并成一坨。
 *   `endedAt` 是最后一次增量到达时刻，时长 = endedAt - startedAt。
 * - `text`：正文切片，只记 `message.content` 的偏移；`to` 为 null 表示延伸到末尾。
 * - `tools`：一批连续的工具调用，引用 `message.tools` 里的 toolCallId。
 */
export type MessageSegment =
  | { kind: "thinking"; id: string; text: string; startedAt: number; endedAt: number }
  | { kind: "text"; id: string; from: number; to: number | null }
  | { kind: "tools"; id: string; toolCallIds: string[] };

/** 思考段（组件 props 用的具名别名）。 */
export type ThinkingSegment = Extract<MessageSegment, { kind: "thinking" }>;

export type AttachmentKind = "image" | "text";

/**
 * 一条随消息发出的附件（图片 / 文本文件）。
 *
 * 生命周期分两段：采集期是内存草稿（只有 dataUrl/text，用于输入卡即时预览），
 * 发送时落进附件库并**剥离内联数据**只留 path —— 会话是整条 ThreadMessage 落盘的，
 * 把 base64 留在消息里会把 localStorage 与会话 JSON 一起撑爆。浏览器态没有
 * 文件系统，只能保留内联副本（限额因此更严）。
 */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** 原始文件名（basename，展示与内联标题用）。 */
  name: string;
  mime: string;
  /** 字节数。 */
  size: number;
  /** 桌面态落库后的绝对路径：~/.greyWork/attachments/<会话id>/<附件id>.<ext>。 */
  path?: string;
  /** 图片数据副本：浏览器态唯一真源 / 桌面态仅存在于落库前的草稿。 */
  dataUrl?: string;
  /** 文本内容副本：仅浏览器态保留（桌面态发送时按 path 现读）。 */
  text?: string;
  /** 文本已按内联上限截断（仅浏览器态可判定，用于展示提示）。 */
  truncated?: boolean;
}

/**
 * 待确认的定时任务提案（AI 回复中的 ```schedule 围栏解析产物）。
 * 随会话整条持久化：回合结束/重启后仍可确认；`createdId` 非空 = 已收口
 * （卡片转只读，回放渲染也不会重复建任务）。
 */
export interface ScheduleDraft {
  name: string;
  /** 每次触发时下发给模型的指令文本。 */
  intent: string;
  /** 标准 cron 5 段表达式；与 onceAt 二选一。 */
  cron?: string;
  /** 一次性触发时刻（epoch ms）。 */
  onceAt?: number;
  /** 创建成功后的任务 id（automation store）。 */
  createdId?: string;
}

/**
 * 一次权限请求的裁决留痕（ACP session/request_permission）。
 *
 * 活跃态卡片挂在输入框上方（那是「等你点」的位置，对 120s 超时窗口最友好）；
 * 一旦裁决就转成本结构随消息落盘，在消息流里留一条只读记录 —— 与 AskQuestionCard /
 * ScheduleConfirmCard 的 settled 态同一约定：事后回看能知道「当时批了什么」。
 */
export interface PermissionTrace {
  toolCallId: string;
  title: string | null;
  /** 宿主 label 化的工具类别（read / edit / execute / …）。 */
  kind: string;
  /** 本请求涉及的路径（协议 locations）；execute 类通常为空。 */
  paths: string[];
  /** 命令正文（从 agent 的 rawInput 机会性提取，见 lib/permission-detail）；取不到为 null。 */
  command: string | null;
  /** 用户看到的选项名（或拒绝文案）；null = 拒绝 / 取消。 */
  choice: string | null;
  /** 谁做的决定：用户点选 / 宿主按档位自动 / 超时兜底取消。 */
  source: "user" | "auto" | "timeout";
  decidedAt: number;
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  steps?: ChatStep[];
  planPending?: boolean;
  /** 计划门待派发的意图文本（ACP 计划卡：确认后作为 prompt 派发，取消则丢弃）。 */
  planDraft?: string;
  attachments?: Attachment[];
  /** 计划门待派发附件（确认后随 planDraft 一起交给 ACP；取消则丢弃）。 */
  planAttachments?: Attachment[];
  /** 完成后产出的交付物 id（artifactStore.artifacts） */
  artifacts?: string[];
  /** 本条消息内的工具调用时间线（会话消息中嵌入；沿用 ACP 同款生命周期）。 */
  tools?: ToolActivity[];
  /** 待用户作答的提问（AskUserQuestion）；作答后 answers 非空，卡片转只读。 */
  ask?: AskRequest;
  /** 待确认的定时任务提案（```schedule 围栏）；确认后 createdId 非空，取消则移除。 */
  scheduleDraft?: ScheduleDraft;
  /**
   * 本条消息内发生的权限裁决留痕，按发生顺序排列。
   *
   * 用数组而非单值：一个 ACP 回合里 agent 可能连续请求多次权限（每个 bash 命令一次），
   * 单值字段后一次会把前一次冲掉，用户回看就只剩最后一条。
   */
  permissions?: PermissionTrace[];
  /** ACP 后端派发消息的来源提供方名（内部 LLM 管线无此字段） */
  acp?: string;
  /**
   * 有序段落：一个回合里 agent 可能思考 → 答话 → 调工具 → 再思考，
   * 渲染必须按到达顺序分段，否则后来的思考会被并进同一坨、或掉到正文里。
   * text 段只记 content 的偏移区间，避免正文存两份。
   */
  segments?: MessageSegment[];
  /** 会话内提示条（M7）：非空时消息渲染 TipBanner（tips 分支） */
  tip?: MessageTip;
}

/**
 * 消息主类型（M7）——对标 GreyWork `Messages/MessageList.tsx` 的 14 种消息类型，
 * 按 GreyWork 的扁平 ThreadMessage 归并分组：
 *  - `text`      ← GreyWork `text`
 *  - `thinking`  ← `thinking`
 *  - `tool_use`  ← `tool_call` / `tool_group` / `acp_tool_call` / `acp_terminal_output`
 *  - `tips`      ← `tips`
 *  - `artifact`  ← `artifact`
 *  - `plan`      ← `plan`（确认即执行）
 *  - `system`    ← `system` / `available_commands` / `agent_status` / `ask` / `permission`
 *  - `user`      ← 用户输入气泡
 * 一条消息可能同时携带多个侧面（thinking + text + tools + artifacts）；此类型是主导面，
 * 用于外层 `data-message-kind` 与 a11y 标注，具体渲染仍按各字段分块。
 */
export type MessageKind = "user" | "text" | "thinking" | "tool_use" | "tips" | "artifact" | "plan" | "system";

/** 提示条（M7 tips 分支）的基调。 */
export type MessageTipTone = "info" | "success" | "warn";

/** 会话内提示条内容（对标 GreyWork `MessageTips.tsx`）。 */
export interface MessageTip {
  tone: MessageTipTone;
  text: string;
}

/** 发送队列中的一条待发指令（M5）：回复期间下发的消息先入队，回合结束再补发。 */
export interface QueuedCommand {
  id: string;
  input: string;
  attachments: Attachment[];
  ts: number;
}

export interface CommandEntry {
  input: string;
  ts: number;
  threadId: string;
}

export type ArtifactType = "report" | "diff" | "dataset";

export interface Artifact {
  id: string;
  name: string;
  meta: string;
  type: ArtifactType;
  /** 来源 agent / 管线 */
  source: string;
  createdAt: number;
  /** 产物文件格式（预览/下载据此路由）；缺省按 name 后缀推断。 */
  format?: "md" | "csv" | "xlsx" | "pptx" | "html";
  /** 产物在虚拟文件系统中的路径；对话内「文件变更」块据此定位与预览。 */
  path?: string;
  /**
   * 产物在真实磁盘上的绝对路径（桌面端默认落盘结果）。
   * 卡片的「在文件夹中打开」据此定位；浏览器态无磁盘通道，此项缺省。
   */
  diskPath?: string;
}
