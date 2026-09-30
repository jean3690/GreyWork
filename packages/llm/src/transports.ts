/** LLM 直连传输抽象：desktop 走 Tauri IPC（Rust 宿主 reqwest），web 无直连通道。 */

import { isTauriRuntime } from "@greywork/core";

export { isTauriRuntime };

export interface LlmEventEnvelope {
  kind: "llm-delta" | "llm-thinking-delta" | "llm-done" | "llm-error";
  payload: { delta?: string; message?: string; clientToken?: string };
}

/**
 * 消息内容块（OpenAI vision 线格式）。纯文本消息仍用 string，只有带附件时才升级成数组，
 * 兼容端点不必为「用不到的 parts」买单。
 */
export type LlmContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** 对话消息（与 Rust 侧 LlmChatMessage 对应）。 */
export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmChatParams {
  baseUrl: string;
  model: string;
  /** 密钥所在环境变量名；宿主侧解析，密钥不经过渲染端 */
  apiKeyEnv?: string;
  messages: LlmChatMessage[];
  /** 推理等级（auto/low/medium/high/max）；宿主侧映射为供应商参数，auto/缺省不传 */
  reasoningEffort?: string;
  /**
   * 附加请求头；值支持 `{{ENV_VAR}}` 占位符，由宿主在发请求时从环境变量解析。
   * 解析失败（环境变量未设置）该笔请求整体报错，不静默丢头。
   */
  headers?: Record<string, string>;
  /** 采样温度（0–2）。仅本地/兼容端点需要时显式设置，缺省不传。 */
  temperature?: number;
  /** 单轮最大输出 token。缺省不传（由服务端默认值决定）。 */
  maxTokens?: number;
  /**
   * 本轮流水的调用方令牌，宿主原样回灌进每条事件。
   *
   * `llm://event` 是全局广播：会话流与远程助手回复可能同时在跑，
   * 消费方拿这个令牌过滤出属于自己那一笔（缺省 = 事件不带令牌，消费方按旧行为全收）。
   */
  clientToken?: string;
}

/** 连接参数：模型发现 / 向量 / 语音转写共用（都是打同一个 OpenAI 兼容端点）。 */
export interface LlmConnection {
  baseUrl: string;
  /** 密钥所在环境变量名；空 = 本地服务（匿名请求）。 */
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export interface LlmEmbedParams extends LlmConnection {
  model: string;
  input: string[];
}

export interface LlmEmbedResult {
  embeddings: number[][];
  dim: number;
  model: string;
}

export interface LlmTranscribeParams extends LlmConnection {
  model: string;
  /** 音频文件的**授权路径**（附件落在授权根内），宿主侧读取。 */
  path: string;
  language?: string;
}

export interface LlmTranscribeResult {
  text: string;
}

export interface LlmClient {
  isAvailable(): boolean;
  chat(params: LlmChatParams): Promise<number>;
  stop(requestId: number): Promise<void>;
  onEvent(listener: (event: LlmEventEnvelope) => void): Promise<() => void>;
  /** 拉取 `/models` 清单（设置页模型下拉，兼作连通性自检）。 */
  listModels(connection: LlmConnection): Promise<string[]>;
  /** 批量取文本向量（本地 RAG 索引用）。 */
  embed(params: LlmEmbedParams): Promise<LlmEmbedResult>;
  /** 语音转写（本地 STT，OpenAI 兼容 `/audio/transcriptions`）。 */
  transcribe(params: LlmTranscribeParams): Promise<LlmTranscribeResult>;
}
