/** workbench 共享领域类型（mock 阶段形状，后续接真实包时在此演进）。 */

export interface Project {
  id: string;
  name: string;
  description: string;
}

export interface ThreadItem {
  id: string;
  title: string;
  time: string;
}

export interface ThreadGroup {
  project: string;
  projectId?: string;
  threads: ThreadItem[];
}

export type ChatStepKind = "read" | "exec" | "test" | "search" | "write";

export interface ChatStep {
  kind: ChatStepKind;
  label: string;
  detail: string;
  status: "wait" | "running" | "done";
}

export interface ThreadMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
  steps?: ChatStep[];
  planPending?: boolean;
  attachments?: string[];
  /** 完成后产出的交付物 id（artifactStore.artifacts） */
  artifacts?: string[];
  /** ACP 后端派发消息的来源提供方名（内部 LLM 管线无此字段） */
  acp?: string;
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
}

export interface ReviewItem {
  level: "high" | "medium" | "low";
  file: string;
  comment: string;
}

export interface SourceRef {
  title: string;
  host: string;
}
